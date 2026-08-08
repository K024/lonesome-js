use std::collections::BTreeSet;
use std::hash::{BuildHasher, Hasher};
use std::net::{Ipv6Addr, SocketAddr as StdSocketAddr, SocketAddrV6};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, OnceLock};

use futures::executor::block_on;
use hashbrown::DefaultHashBuilder;
use pingora::lb::discovery;
use pingora::lb::selection::{BackendIter, BackendSelection, Consistent, RoundRobin};
use pingora::lb::{Backend, Backends, Extensions, LoadBalancer};
use pingora::protocols::l4::socket::SocketAddr;

use crate::config::{LoadBalancerAlgorithm, LoadBalancerConfig};
use crate::upstream::upstream::UpstreamEndpoint;

#[derive(Clone, Copy, Debug)]
pub struct EndpointIndex(pub usize);

#[derive(Debug)]
pub struct PassiveHealthStateInner {
  tolerance: AtomicI64,
  next_window: AtomicI64,
  tracked: AtomicBool,
}

#[derive(Clone, Default, Debug)]
pub struct PassiveHealthState(Arc<PassiveHealthStateInner>);

impl Default for PassiveHealthStateInner {
  fn default() -> Self {
    Self {
      tolerance: AtomicI64::new(0),
      next_window: AtomicI64::new(0),
      tracked: AtomicBool::new(false),
    }
  }
}

impl PassiveHealthState {
  pub fn observe_failure(&self, next_window: i64) {
    self.0.tolerance.fetch_sub(1, Ordering::Relaxed);
    self.0.next_window.store(next_window, Ordering::Relaxed)
  }

  pub fn observe_success(&self, allowed_failures: i64) {
    self.0.tolerance.store(allowed_failures, Ordering::Relaxed)
  }

  pub fn is_healthy(&self, now: i64) -> bool {
    if self.0.tolerance.load(Ordering::Relaxed) >= 0 {
      return true;
    }
    if self.0.next_window.load(Ordering::Relaxed) <= now {
      return true;
    }
    false
  }

  pub fn tolerance(&self) -> i64 {
    self.0.tolerance.load(Ordering::Relaxed)
  }

  pub fn mark_tracked(&self) {
    self.0.tracked.store(true, Ordering::Relaxed);
  }

  pub fn tracked(&self) -> bool {
    self.0.tracked.load(Ordering::Relaxed)
  }
}

pub trait DynLoadBalancer: Send + Sync {
  fn select_backend(&self, key: &[u8], max_iterations: usize) -> Option<Backend>;

  fn select_backend_with(
    &self,
    key: &[u8],
    max_iterations: usize,
    accept: &dyn Fn(&Backend, bool) -> bool,
  ) -> Option<Backend>;

  fn upstream_health(&self, now: i64) -> Vec<(usize, Option<(bool, i64)>)>;
}

fn collect_upstream_health<S>(lb: &LoadBalancer<S>, now: i64) -> Vec<(usize, Option<(bool, i64)>)>
where
  S: BackendSelection + Send + Sync + 'static,
  S::Iter: BackendIter,
{
  let mut out = Vec::new();
  for backend in lb.backends().get_backend().iter() {
    let Some(idx) = backend.ext.get::<EndpointIndex>() else {
      continue;
    };
    let state = backend.ext.get::<PassiveHealthState>();
    let health = state.and_then(|s| {
      s.tracked()
        .then(|| (is_backend_healthy(backend, now), s.tolerance()))
    });
    out.push((idx.0, health));
  }
  out
}

struct RoundRobinDynLb {
  inner: LoadBalancer<RoundRobin>,
}

impl DynLoadBalancer for RoundRobinDynLb {
  fn select_backend(&self, key: &[u8], max_iterations: usize) -> Option<Backend> {
    self.inner.select(key, max_iterations)
  }

  fn select_backend_with(
    &self,
    key: &[u8],
    max_iterations: usize,
    accept: &dyn Fn(&Backend, bool) -> bool,
  ) -> Option<Backend> {
    self
      .inner
      .select_with(key, max_iterations, |backend, healthy| {
        accept(backend, healthy)
      })
  }

  fn upstream_health(&self, now: i64) -> Vec<(usize, Option<(bool, i64)>)> {
    collect_upstream_health(&self.inner, now)
  }
}

struct ConsistentDynLb {
  inner: LoadBalancer<Consistent>,
}

impl DynLoadBalancer for ConsistentDynLb {
  fn select_backend(&self, key: &[u8], max_iterations: usize) -> Option<Backend> {
    self.inner.select(key, max_iterations)
  }

  fn select_backend_with(
    &self,
    key: &[u8],
    max_iterations: usize,
    accept: &dyn Fn(&Backend, bool) -> bool,
  ) -> Option<Backend> {
    self
      .inner
      .select_with(key, max_iterations, |backend, healthy| {
        accept(backend, healthy)
      })
  }

  fn upstream_health(&self, now: i64) -> Vec<(usize, Option<(bool, i64)>)> {
    collect_upstream_health(&self.inner, now)
  }
}

/// Return a synthetic inet address for endpoints that do not have one.
///
/// Pingora's Ketama implementation only puts inet backends on the ring. Unix
/// sockets and virtual JS endpoints therefore use an address under RFC 3849's
/// documentation-only `2001:db8::/32` range as their stable ring identity.
/// This address is never connected to: `EndpointIndex` maps the selected
/// backend back to the actual endpoint.
///
/// The identity is deliberately based on endpoint configuration rather than
/// its position in the route. Reordering unchanged upstreams during a route
/// hot reload consequently preserves their Ketama identities.
pub fn synthetic_backend_addr(endpoint: &UpstreamEndpoint) -> Result<SocketAddr, String> {
  static SYNTHETIC_ADDRESS_HASHER: OnceLock<DefaultHashBuilder> = OnceLock::new();
  let mut hasher = SYNTHETIC_ADDRESS_HASHER
    .get_or_init(Default::default)
    .build_hasher();

  match endpoint {
    #[cfg(unix)]
    UpstreamEndpoint::Unix { path, .. } => {
      hasher.write(b"unix\0");
      hasher.write(path.as_bytes());
    }
    UpstreamEndpoint::VirtualJs { key, .. } => {
      hasher.write(b"virtual_js\0");
      hasher.write(key.as_bytes());
    }
    UpstreamEndpoint::Tcp { address, .. } => {
      return Err(format!(
        "cannot generate a synthetic backend address for tcp upstream '{address}'"
      ));
    }
  }

  // Cross-version/process stability is not part of this internal identity
  // contract. The same endpoint configuration maps consistently while this
  // server instance is alive, including across route-table hot reloads.
  let digest = hasher.finish().to_be_bytes();

  let mut octets = [0_u8; 16];
  octets[..4].copy_from_slice(&[0x20, 0x01, 0x0d, 0xb8]);
  octets[8..].copy_from_slice(&digest);
  Ok(SocketAddr::Inet(StdSocketAddr::V6(SocketAddrV6::new(
    Ipv6Addr::from(octets),
    1,
    0,
    0,
  ))))
}

pub fn build_load_balancer(
  upstreams: &[UpstreamEndpoint],
  cfg: &LoadBalancerConfig,
) -> Result<Option<Box<dyn DynLoadBalancer>>, String> {
  let mut backends_set = BTreeSet::new();

  for (idx, upstream) in upstreams.iter().enumerate() {
    let backend = match upstream {
      UpstreamEndpoint::Tcp {
        address, weight, ..
      } => {
        let mut ext = Extensions::new();
        ext.insert(EndpointIndex(idx));
        ext.insert(PassiveHealthState::default());

        Backend {
          addr: SocketAddr::from_str(address)
            .map_err(|e| format!("invalid tcp upstream address '{address}': {e}"))?,
          weight: *weight as usize,
          ext,
        }
      }
      #[cfg(unix)]
      UpstreamEndpoint::Unix { weight, .. } => {
        let mut ext = Extensions::new();
        ext.insert(EndpointIndex(idx));
        ext.insert(PassiveHealthState::default());

        Backend {
          addr: synthetic_backend_addr(upstream)?,
          weight: *weight as usize,
          ext,
        }
      }
      UpstreamEndpoint::VirtualJs { weight, .. } => {
        let mut ext = Extensions::new();
        ext.insert(EndpointIndex(idx));
        ext.insert(PassiveHealthState::default());

        Backend {
          addr: synthetic_backend_addr(upstream)?,
          weight: *weight as usize,
          ext,
        }
      }
    };

    backends_set.insert(backend);
  }

  if backends_set.is_empty() {
    return Ok(None);
  }

  let backends = Backends::new(discovery::Static::new(backends_set));

  match cfg.algorithm {
    LoadBalancerAlgorithm::RoundRobin => {
      let lb = LoadBalancer::<RoundRobin>::from_backends(backends);
      block_on(lb.update()).map_err(|e| format!("failed to update round_robin lb: {e}"))?;
      Ok(Some(Box::new(RoundRobinDynLb { inner: lb })))
    }
    LoadBalancerAlgorithm::ConsistentHash => {
      let lb = LoadBalancer::<Consistent>::from_backends(backends);
      block_on(lb.update()).map_err(|e| format!("failed to update consistent_hash lb: {e}"))?;
      Ok(Some(Box::new(ConsistentDynLb { inner: lb })))
    }
  }
}

pub fn is_backend_healthy(backend: &Backend, now: i64) -> bool {
  let Some(state) = backend.ext.get::<PassiveHealthState>() else {
    return true;
  };
  state.is_healthy(now)
}

pub fn observe_backend_health(
  backend: &Backend,
  success: bool,
  now: i64,
  failure_window_ms: i64,
  max_attempts: i64,
) {
  let Some(state) = backend.ext.get::<PassiveHealthState>() else {
    return;
  };
  state.mark_tracked();
  if success {
    state.observe_success(max_attempts);
  } else {
    let next_window = now + failure_window_ms;
    state.observe_failure(next_window);
  }
}
