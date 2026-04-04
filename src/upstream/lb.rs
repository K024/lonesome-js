use std::collections::BTreeSet;
use std::str::FromStr;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use futures::executor::block_on;
use pingora::lb::discovery;
use pingora::lb::selection::{Consistent, RoundRobin};
use pingora::lb::{Backend, Backends, Extensions, LoadBalancer};
use pingora::protocols::l4::socket::SocketAddr;

use crate::config::{LoadBalancerAlgorithm, LoadBalancerConfig};
use crate::upstream::upstream::UpstreamEndpoint;

#[derive(Clone, Copy, Debug)]
pub struct EndpointIndex(pub usize);

#[derive(Debug)]
pub struct PassiveHealthStateInner {
  pub tolerance: AtomicI64,
  pub next_window: AtomicI64,
}

#[derive(Clone, Default, Debug)]
pub struct PassiveHealthState(Arc<PassiveHealthStateInner>);

impl Default for PassiveHealthStateInner {
  fn default() -> Self {
    Self {
      tolerance: AtomicI64::new(0),
      next_window: AtomicI64::new(0),
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
}

pub trait DynLoadBalancer: Send + Sync {
  fn select_backend(&self, key: &[u8], max_iterations: usize) -> Option<Backend>;

  fn select_backend_with(
    &self,
    key: &[u8],
    max_iterations: usize,
    accept: &dyn Fn(&Backend, bool) -> bool,
  ) -> Option<Backend>;
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
}

// use TEST-NET-1: 192.0.2.0/24 (RFC 5737 reserved documentation/testing range).
fn virtual_js_placeholder_addr(idx: usize, key: &str) -> Result<SocketAddr, String> {
  const MAX_BACKENDS: usize = 254; // Support only 254 backends (idx 1-254)
  const PORT: u16 = 1;

  if idx >= MAX_BACKENDS {
    return Err(format!(
      "too many virtual upstreams: index {idx} exceeds maximum capacity {MAX_BACKENDS}"
    ));
  }

  let host = idx as u8 + 1;
  let placeholder = format!("192.0.2.{}:{}", host, PORT);
  SocketAddr::from_str(&placeholder)
    .map_err(|e| format!("invalid virtual upstream placeholder for '{key}': {e}"))
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
      UpstreamEndpoint::Unix { path, weight, .. } => {
        let mut ext = Extensions::new();
        ext.insert(EndpointIndex(idx));
        ext.insert(PassiveHealthState::default());

        Backend {
          addr: SocketAddr::from_str(&format!("unix:{path}"))
            .map_err(|e| format!("invalid unix upstream path '{path}': {e}"))?,
          weight: *weight as usize,
          ext,
        }
      }
      UpstreamEndpoint::VirtualJs { key, weight, .. } => {
        let mut ext = Extensions::new();
        ext.insert(EndpointIndex(idx));
        ext.insert(PassiveHealthState::default());

        Backend {
          addr: virtual_js_placeholder_addr(idx, key)?,
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
  if success {
    state.observe_success(max_attempts);
  } else {
    let next_window = now + failure_window_ms;
    state.observe_failure(next_window);
  }
}
