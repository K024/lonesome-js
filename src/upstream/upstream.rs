use std::collections::HashMap;

use cel::{Program, Value};
use pingora::lb::Backend;
use pingora::upstreams::peer::HttpPeer;
use pingora::{Error, ErrorType, Result};

use crate::config::{
  LoadBalancerAlgorithm, LoadBalancerConfig, LoadBalancerStatus, UpstreamAddressConfig,
  UpstreamConfig, UpstreamHealthStatus, UpstreamStatus,
};
use crate::proxy::ctx::ProxyCtx;
use crate::upstream::lb::synthetic_backend_addr;
use crate::virtual_js::virtual_open_connection;

use super::lb::{build_load_balancer, is_backend_healthy, DynLoadBalancer, EndpointIndex};

#[derive(Clone, Debug)]
pub struct UpstreamState {
  pub retries: i32,
  pub last_endpoint_index: Option<usize>,
  pub last_backend: Option<Backend>,
}

#[derive(Clone)]
pub enum UpstreamEndpoint {
  Tcp {
    address: String,
    tls: bool,
    h2c: bool,
    sni: String,
    weight: u32,
  },
  #[cfg(unix)]
  Unix {
    path: String,
    tls: bool,
    h2c: bool,
    sni: String,
    weight: u32,
  },
  VirtualJs {
    key: String,
    tls: bool,
    h2c: bool,
    sni: String,
    weight: u32,
  },
}

impl UpstreamEndpoint {
  pub fn kind(&self) -> &'static str {
    match self {
      UpstreamEndpoint::Tcp { .. } => "tcp",
      #[cfg(unix)]
      UpstreamEndpoint::Unix { .. } => "unix",
      UpstreamEndpoint::VirtualJs { .. } => "virtual_js",
    }
  }

  pub fn address(&self) -> String {
    match self {
      UpstreamEndpoint::Tcp { address, .. } => address.clone(),
      #[cfg(unix)]
      UpstreamEndpoint::Unix { path, .. } => path.clone(),
      UpstreamEndpoint::VirtualJs { key, .. } => key.clone(),
    }
  }

  pub fn weight(&self) -> u32 {
    match self {
      UpstreamEndpoint::Tcp { weight, .. } => *weight,
      #[cfg(unix)]
      UpstreamEndpoint::Unix { weight, .. } => *weight,
      UpstreamEndpoint::VirtualJs { weight, .. } => *weight,
    }
  }
}

pub struct UpstreamPool {
  endpoints: Vec<UpstreamEndpoint>,
  lb: Option<Box<dyn DynLoadBalancer>>,
  lb_cfg: LoadBalancerConfig,
  hash_key_program: Option<Program>,
}

impl UpstreamPool {
  pub fn from_config(
    upstreams: &[UpstreamConfig],
    lb_cfg: Option<LoadBalancerConfig>,
  ) -> Result<Self, String> {
    if upstreams.is_empty() {
      return Err("route.upstreams cannot be empty".to_string());
    }

    let endpoints = upstreams
      .iter()
      .map(|cfg| match &cfg.address {
        UpstreamAddressConfig::Tcp(address) => UpstreamEndpoint::Tcp {
          address: address.clone(),
          tls: cfg.tls,
          h2c: cfg.h2c.unwrap_or(false),
          sni: cfg.sni.clone().unwrap_or_default(),
          weight: cfg.weight,
        },
        #[cfg(unix)]
        UpstreamAddressConfig::Unix(path) => UpstreamEndpoint::Unix {
          path: path.clone(),
          tls: cfg.tls,
          h2c: cfg.h2c.unwrap_or(false),
          sni: cfg.sni.clone().unwrap_or_default(),
          weight: cfg.weight,
        },
        UpstreamAddressConfig::VirtualJs(key) => UpstreamEndpoint::VirtualJs {
          key: key.clone(),
          tls: cfg.tls,
          h2c: cfg.h2c.unwrap_or(false),
          sni: cfg.sni.clone().unwrap_or_default(),
          weight: cfg.weight,
        },
      })
      .collect::<Vec<_>>();

    let lb_cfg = lb_cfg.unwrap_or_else(|| {
      if endpoints.len() > 1 {
        // NOTE: Pingora Ketama/consistent_hash currently ignores Unix socket backends.
        // Callers using multiple Unix upstreams should explicitly configure round_robin.
        LoadBalancerConfig {
          algorithm: LoadBalancerAlgorithm::ConsistentHash,
          max_iterations: 32,
          hash_key_rule: None,
        }
      } else {
        LoadBalancerConfig::default()
      }
    });

    let lb = build_load_balancer(&endpoints, &lb_cfg)?;

    let hash_key_program = lb_cfg
      .hash_key_rule
      .as_ref()
      .map(|expr| {
        Program::compile(expr).map_err(|e| format!("invalid lb.hash_key_rule '{expr}': {e}"))
      })
      .transpose()?;

    Ok(Self {
      endpoints,
      lb,
      lb_cfg,
      hash_key_program,
    })
  }

  pub fn load_balancer_status(&self) -> LoadBalancerStatus {
    let algorithm = match self.lb_cfg.algorithm {
      LoadBalancerAlgorithm::RoundRobin => "round_robin",
      LoadBalancerAlgorithm::ConsistentHash => "consistent_hash",
    };
    LoadBalancerStatus {
      algorithm: algorithm.to_string(),
      max_iterations: self.lb_cfg.max_iterations,
      hash_key_rule: self.lb_cfg.hash_key_rule.clone(),
    }
  }

  pub fn status(&self) -> Vec<UpstreamStatus> {
    let now = chrono::Utc::now().timestamp_millis();
    let health_map: HashMap<usize, (bool, i64)> = self
      .lb
      .as_ref()
      .map(|lb| {
        lb.upstream_health(now)
          .into_iter()
          .filter_map(|(idx, health)| health.map(|h| (idx, h)))
          .collect()
      })
      .unwrap_or_default();

    self
      .endpoints
      .iter()
      .enumerate()
      .map(|(idx, endpoint)| UpstreamStatus {
        kind: endpoint.kind().to_string(),
        address: endpoint.address(),
        weight: endpoint.weight(),
        health: health_map
          .get(&idx)
          .map(|(healthy, tolerance)| UpstreamHealthStatus {
            healthy: *healthy,
            tolerance: *tolerance,
          }),
      })
      .collect()
  }

  pub fn select_peer(&self, proxy_ctx: &mut ProxyCtx, route_id: &str) -> Result<Box<HttpPeer>> {
    let key = self.selection_key(proxy_ctx)?;
    let max_iterations = self.lb_cfg.max_iterations;

    if self.endpoints.len() == 1 {
      // Single endpoint: select unconditionally (no health gating) so a cooling
      // down worker still receives connection attempts and recovers immediately.
      // Health is still recorded via `last_backend` so `status()` can report it,
      // and connect-phase retries (health_check middleware) keep working.
      let Some(lb) = &self.lb else {
        return Err(Error::because(
          ErrorType::InternalError,
          "upstream selection failed",
          std::io::Error::other(format!("route '{route_id}' has no load balancer")),
        ));
      };
      let backend = lb
        .select_backend(&key, max_iterations)
        .ok_or_else(|| {
          Error::because(
            ErrorType::HTTPStatus(502),
            "upstream selection failed",
            std::io::Error::other(format!("route '{route_id}' failed to select an upstream backend")),
          )
        })?;
      if let Some(state) = proxy_ctx.upstream_state.as_mut() {
        state.last_endpoint_index = backend.ext.get::<EndpointIndex>().map(|idx| idx.0);
        state.last_backend = Some(backend.clone());
      }
      return self.peer_from_backend(&backend);
    }

    // only if upstream_state is set, check if the backend is healthy
    if let Some(state) = proxy_ctx.upstream_state.as_mut() {
      if let Some(lb) = &self.lb {
        let now = chrono::Utc::now().timestamp_millis();
        if let Some(backend) =
          lb.select_backend_with(&key, max_iterations, &|backend: &Backend, healthy: bool| {
            healthy && is_backend_healthy(backend, now)
          })
        {
          let peer = self.peer_from_backend(&backend);
          state.last_endpoint_index = backend.ext.get::<EndpointIndex>().map(|idx| idx.0);
          state.last_backend = Some(backend);
          return peer;
        }
      }
    } else {
      if let Some(lb) = &self.lb {
        if let Some(backend) = lb.select_backend(&key, max_iterations) {
          return self.peer_from_backend(&backend);
        }
      }
    }

    Err(Error::because(
      ErrorType::HTTPStatus(502),
      "upstream selection failed",
      std::io::Error::other(format!(
        "route '{route_id}' failed to select healthy upstream backend"
      )),
    ))
  }

  fn selection_key(&self, proxy_ctx: &ProxyCtx) -> Result<Vec<u8>> {
    let Some(program) = &self.hash_key_program else {
      return Ok(Vec::new());
    };

    let ctx = proxy_ctx
      .session_cel_context
      .as_ref()
      .map(|r| r.cel_ctx.as_ref())
      .ok_or_else(|| {
        Error::because(
          ErrorType::InternalError,
          "upstream selection failed",
          std::io::Error::other("proxy cel context is not initialized"),
        )
      })?;

    match program.execute(ctx) {
      Ok(Value::String(v)) => Ok(v.as_bytes().to_vec()),
      Ok(Value::Int(v)) => Ok(v.to_string().into_bytes()),
      Ok(Value::UInt(v)) => Ok(v.to_string().into_bytes()),
      Ok(Value::Bool(v)) => Ok(v.to_string().into_bytes()),
      Ok(other) => Err(Error::because(
        ErrorType::InternalError,
        "upstream selection failed",
        std::io::Error::other(format!(
          "lb.hash_key_rule must resolve to scalar, got {other:?}"
        )),
      )),
      Err(e) => Err(Error::because(
        ErrorType::InternalError,
        "upstream selection failed",
        std::io::Error::other(format!("failed to evaluate lb.hash_key_rule: {e}")),
      )),
    }
  }

  fn peer_from_backend(&self, backend: &Backend) -> Result<Box<HttpPeer>> {
    let endpoint_idx = backend.ext.get::<EndpointIndex>().ok_or_else(|| {
      Error::because(
        ErrorType::InternalError,
        "upstream selection failed",
        std::io::Error::other(format!(
          "selected backend '{}' missing endpoint index extension",
          backend.addr
        )),
      )
    })?;

    let endpoint = self.endpoints.get(endpoint_idx.0).ok_or_else(|| {
      Error::because(
        ErrorType::InternalError,
        "upstream selection failed",
        std::io::Error::other(format!(
          "selected backend '{}' points to invalid endpoint index {}",
          backend.addr, endpoint_idx.0
        )),
      )
    })?;

    self.peer_from_endpoint(endpoint)
  }

  fn peer_from_endpoint(&self, endpoint: &UpstreamEndpoint) -> Result<Box<HttpPeer>> {
    match endpoint {
      UpstreamEndpoint::Tcp {
        address,
        tls,
        h2c,
        sni,
        ..
      } => {
        let mut peer = HttpPeer::new(address, *tls, sni.clone());
        if !*tls && *h2c {
          peer.options.set_http_version(2, 2);
        }
        Ok(Box::new(peer))
      }
      #[cfg(unix)]
      UpstreamEndpoint::Unix {
        path,
        tls,
        h2c,
        sni,
        ..
      } => {
        let mut peer = HttpPeer::new_uds(path, *tls, sni.clone()).map_err(|e| {
          Error::because(
            ErrorType::InternalError,
            "upstream selection failed",
            std::io::Error::other(format!("failed to create uds peer: {e}")),
          )
        })?;
        if !*tls && *h2c {
          peer.options.set_http_version(2, 2);
        }
        Ok(Box::new(peer))
      }
      endpoint @ UpstreamEndpoint::VirtualJs {
        key, tls, h2c, sni, ..
      } => {
        let dummy_addr = synthetic_backend_addr(endpoint).map_err(|e| {
          Error::because(
            ErrorType::InternalError,
            "synthetic addr for virtual_js creation failed",
            std::io::Error::other(e),
          )
        })?;
        let peer =
          virtual_open_connection(key, &dummy_addr, *tls, *h2c, sni.clone()).map_err(|e| {
            Error::because(
              ErrorType::InternalError,
              "upstream selection failed",
              std::io::Error::other(e),
            )
          })?;
        Ok(Box::new(peer))
      }
    }
  }
}
