use napi_derive::napi;

use crate::config::{
  ListenerStatus as CoreListenerStatus, LoadBalancerStatus as CoreLoadBalancerStatus,
  RouteStatus as CoreRouteStatus, ServerStatus as CoreServerStatus,
  UpstreamHealthStatus as CoreUpstreamHealthStatus, UpstreamStatus as CoreUpstreamStatus,
};

#[napi(object)]
pub struct ServerStatus {
  pub running: bool,
  pub route_count: u32,
  pub threads: u32,
  pub work_stealing: bool,
  #[napi(ts_type = "'loose_by_sni' | 'loose_by_header' | 'strict' | 'strict_rewrite_header'")]
  pub sni_host_policy: String,
  pub listeners: Vec<ListenerStatus>,
  pub routes: Vec<RouteStatus>,
}

#[napi(object)]
pub struct ListenerStatus {
  pub kind: String,
  pub addr: String,
}

#[napi(object)]
pub struct RouteStatus {
  pub id: String,
  pub rule: String,
  pub priority: i32,
  pub load_balancer: LoadBalancerStatus,
  pub upstreams: Vec<UpstreamStatus>,
}

#[napi(object)]
pub struct LoadBalancerStatus {
  pub algorithm: String,
  pub max_iterations: u32,
  pub hash_key_rule: Option<String>,
}

#[napi(object)]
pub struct UpstreamStatus {
  pub kind: String,
  pub address: String,
  pub weight: u32,
  pub health: Option<UpstreamHealthStatus>,
}

#[napi(object)]
pub struct UpstreamHealthStatus {
  pub healthy: bool,
  pub tolerance: i64,
}

impl From<CoreServerStatus> for ServerStatus {
  fn from(value: CoreServerStatus) -> Self {
    ServerStatus {
      running: value.running,
      route_count: value.route_count as u32,
      threads: value.threads as u32,
      work_stealing: value.work_stealing,
      sni_host_policy: value.sni_host_policy.as_str().to_string(),
      listeners: value.listeners.into_iter().map(Into::into).collect(),
      routes: value.routes.into_iter().map(Into::into).collect(),
    }
  }
}

impl From<CoreListenerStatus> for ListenerStatus {
  fn from(value: CoreListenerStatus) -> Self {
    ListenerStatus {
      kind: value.kind,
      addr: value.addr,
    }
  }
}

impl From<CoreRouteStatus> for RouteStatus {
  fn from(value: CoreRouteStatus) -> Self {
    RouteStatus {
      id: value.id,
      rule: value.rule,
      priority: value.priority,
      load_balancer: value.load_balancer.into(),
      upstreams: value.upstreams.into_iter().map(Into::into).collect(),
    }
  }
}

impl From<CoreLoadBalancerStatus> for LoadBalancerStatus {
  fn from(value: CoreLoadBalancerStatus) -> Self {
    LoadBalancerStatus {
      algorithm: value.algorithm,
      max_iterations: value.max_iterations as u32,
      hash_key_rule: value.hash_key_rule,
    }
  }
}

impl From<CoreUpstreamStatus> for UpstreamStatus {
  fn from(value: CoreUpstreamStatus) -> Self {
    UpstreamStatus {
      kind: value.kind,
      address: value.address,
      weight: value.weight,
      health: value.health.map(Into::into),
    }
  }
}

impl From<CoreUpstreamHealthStatus> for UpstreamHealthStatus {
  fn from(value: CoreUpstreamHealthStatus) -> Self {
    UpstreamHealthStatus {
      healthy: value.healthy,
      tolerance: value.tolerance,
    }
  }
}
