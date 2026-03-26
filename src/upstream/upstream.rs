use cel::{Program, Value};
use pingora::lb::Backend;
use pingora::upstreams::peer::HttpPeer;

use crate::config::{
  LoadBalancerAlgorithm, LoadBalancerConfig, UpstreamAddressConfig, UpstreamConfig,
};
use crate::proxy::ctx::ProxyCtx;

use super::lb::{build_load_balancer, DynLoadBalancer, EndpointIndex};

#[derive(Clone)]
pub enum UpstreamEndpoint {
  Tcp {
    address: String,
    tls: bool,
    sni: String,
    weight: u32,
  },
  #[cfg(unix)]
  Unix {
    path: String,
    tls: bool,
    sni: String,
    weight: u32,
  },
}

pub struct UpstreamPool {
  endpoints: Vec<UpstreamEndpoint>,
  lb: Option<std::sync::Arc<dyn DynLoadBalancer>>,
  lb_cfg: LoadBalancerConfig,
  hash_key_program: Option<Program>,
}

impl UpstreamPool {
  pub fn from_config(upstreams: &[UpstreamConfig], lb_cfg: Option<LoadBalancerConfig>) -> Result<Self, String> {
    if upstreams.is_empty() {
      return Err("route.upstreams cannot be empty".to_string());
    }

    let endpoints = upstreams
      .iter()
      .map(|cfg| match &cfg.address {
        UpstreamAddressConfig::Tcp(address) => UpstreamEndpoint::Tcp {
          address: address.clone(),
          tls: cfg.tls,
          sni: cfg.sni.clone().unwrap_or_default(),
          weight: cfg.weight,
        },
        #[cfg(unix)]
        UpstreamAddressConfig::Unix(path) => UpstreamEndpoint::Unix {
          path: path.clone(),
          tls: cfg.tls,
          sni: cfg.sni.clone().unwrap_or_default(),
          weight: cfg.weight,
        },
      })
      .collect::<Vec<_>>();

    let lb_cfg = lb_cfg.unwrap_or_else(|| {
      if endpoints.len() > 1 {
        LoadBalancerConfig {
          algorithm: LoadBalancerAlgorithm::ConsistentHash,
          max_iterations: 256,
          hash_key_cel: None,
        }
      } else {
        LoadBalancerConfig::default()
      }
    });

    let lb = if endpoints.len() > 1 {
      build_load_balancer(&endpoints, &lb_cfg)?
    } else {
      None
    };

    let hash_key_program = lb_cfg
      .hash_key_cel
      .as_ref()
      .map(|expr| {
        Program::compile(expr).map_err(|e| format!("invalid lb.hash_key_cel '{expr}': {e}"))
      })
      .transpose()?;

    Ok(Self {
      endpoints,
      lb,
      lb_cfg,
      hash_key_program,
    })
  }

  pub fn select_peer(
    &self,
    proxy_ctx: &ProxyCtx,
    route_id: &str,
  ) -> Result<Box<HttpPeer>, String> {
    if self.endpoints.len() == 1 {
      return self.peer_from_endpoint(&self.endpoints[0]);
    }

    let key = self.selection_key(proxy_ctx)?;
    let max_iterations = self.lb_cfg.max_iterations;

    if let Some(lb) = &self.lb {
      if let Some(backend) = lb.select_backend(&key, max_iterations) {
        return self.peer_from_backend(&backend);
      }
    }

    Err(format!("route '{route_id}' failed to select upstream backend"))
  }

  fn selection_key(&self, proxy_ctx: &ProxyCtx) -> Result<Vec<u8>, String> {
    let Some(program) = &self.hash_key_program else {
      return Ok(Vec::new());
    };

    let ctx = proxy_ctx
      .session_cel_context
      .as_ref()
      .map(|r| r.cel_ctx.as_ref())
      .ok_or_else(|| "proxy cel context is not initialized".to_string())?;

    match program.execute(ctx) {
      Ok(Value::String(v)) => Ok(v.as_bytes().to_vec()),
      Ok(Value::Int(v)) => Ok(v.to_string().into_bytes()),
      Ok(Value::UInt(v)) => Ok(v.to_string().into_bytes()),
      Ok(Value::Bool(v)) => Ok(v.to_string().into_bytes()),
      Ok(other) => Err(format!("lb.hash_key_cel must resolve to scalar, got {other:?}")),
      Err(e) => Err(format!("failed to evaluate lb.hash_key_cel: {e}")),
    }
  }

  fn peer_from_backend(&self, backend: &Backend) -> Result<Box<HttpPeer>, String> {
    let endpoint_idx = backend.ext.get::<EndpointIndex>().ok_or_else(|| {
      format!(
        "selected backend '{}' missing endpoint index extension",
        backend.addr
      )
    })?;

    let endpoint = self.endpoints.get(endpoint_idx.0).ok_or_else(|| {
      format!(
        "selected backend '{}' points to invalid endpoint index {}",
        backend.addr, endpoint_idx.0
      )
    })?;

    self.peer_from_endpoint(endpoint)
  }

  fn peer_from_endpoint(&self, endpoint: &UpstreamEndpoint) -> Result<Box<HttpPeer>, String> {
    match endpoint {
      UpstreamEndpoint::Tcp { address, tls, sni, .. } => {
        Ok(Box::new(HttpPeer::new(address, *tls, sni.clone())))
      }
      #[cfg(unix)]
      UpstreamEndpoint::Unix { path, tls, sni, .. } => HttpPeer::new_uds(path, *tls, sni.clone())
        .map(Box::new)
        .map_err(|e| format!("failed to create uds peer: {e}")),
    }
  }
}
