use crate::config::SniHostPolicy;

/// Read-only status snapshot of the proxy runtime.
///
/// This deliberately contains no measurements: no request counters, latency or
/// error counts. Those are the responsibility of the downstream (JS) layer.
/// `ServerStatus` only reflects what the library actually has registered, plus
/// an optional passive health signal that is present only when a route is
/// configured with the `health_check` middleware.
#[derive(Clone, Debug)]
pub struct ServerStatus {
  pub running: bool,
  pub route_count: usize,
  pub threads: usize,
  pub work_stealing: bool,
  pub sni_host_policy: SniHostPolicy,
  pub error_page_count: usize,
  pub listeners: Vec<ListenerStatus>,
  pub routes: Vec<RouteStatus>,
}

#[derive(Clone, Debug)]
pub struct ListenerStatus {
  pub kind: String,
  pub addr: String,
}

#[derive(Clone, Debug)]
pub struct RouteStatus {
  pub id: String,
  pub rule: String,
  pub priority: i32,
  pub load_balancer: LoadBalancerStatus,
  pub upstreams: Vec<UpstreamStatus>,
}

#[derive(Clone, Debug)]
pub struct LoadBalancerStatus {
  pub algorithm: String,
  pub max_iterations: usize,
  pub hash_key_rule: Option<String>,
}

#[derive(Clone, Debug)]
pub struct UpstreamStatus {
  pub kind: String,
  pub address: String,
  pub weight: u32,
  /// Present only when this upstream has actually been observed by a health
  /// check (`health_check` middleware has recorded a success or failure).
  /// Absent otherwise, meaning the upstream is not being tracked for health.
  pub health: Option<UpstreamHealthStatus>,
}

#[derive(Clone, Debug)]
pub struct UpstreamHealthStatus {
  pub healthy: bool,
  /// Remaining failure tolerance. `>= 0` means healthy; below zero the upstream
  /// stays unhealthy until the failure window expires or enough successes reset it.
  pub tolerance: i64,
}
