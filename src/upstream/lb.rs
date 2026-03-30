use std::collections::BTreeSet;
use std::str::FromStr;

use futures::executor::block_on;
use pingora::lb::discovery;
use pingora::lb::selection::{Consistent, RoundRobin};
use pingora::lb::{Backend, Backends, Extensions, LoadBalancer};
use pingora::protocols::l4::socket::SocketAddr;

use crate::config::{LoadBalancerAlgorithm, LoadBalancerConfig};
use crate::upstream::upstream::UpstreamEndpoint;

#[derive(Clone, Copy, Debug)]
pub struct EndpointIndex(pub usize);

pub trait DynLoadBalancer: Send + Sync {
  fn select_backend(&self, key: &[u8], max_iterations: usize) -> Option<Backend>;
}

struct RoundRobinDynLb {
  inner: LoadBalancer<RoundRobin>,
}

impl DynLoadBalancer for RoundRobinDynLb {
  fn select_backend(&self, key: &[u8], max_iterations: usize) -> Option<Backend> {
    self.inner.select(key, max_iterations)
  }
}

struct ConsistentDynLb {
  inner: LoadBalancer<Consistent>,
}

impl DynLoadBalancer for ConsistentDynLb {
  fn select_backend(&self, key: &[u8], max_iterations: usize) -> Option<Backend> {
    self.inner.select(key, max_iterations)
  }
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

        Backend {
          addr: SocketAddr::from_str(&format!("unix:{path}"))
            .map_err(|e| format!("invalid unix upstream path '{path}': {e}"))?,
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
