use super::middleware_config::MiddlewareConfig;
use super::upstream_config::{LoadBalancerConfig, UpstreamConfig};

#[derive(Clone, Debug)]
pub struct RouteMatcherConfig {
  pub rule: String,
  pub priority: Option<i32>,
}

#[derive(Clone, Debug)]
pub struct RouteConfig {
  pub id: String,
  pub matcher: RouteMatcherConfig,
  pub middlewares: Vec<MiddlewareConfig>,
  pub upstreams: Vec<UpstreamConfig>,
  pub load_balancer: Option<LoadBalancerConfig>,
}

impl RouteConfig {
  pub fn validate(&self) -> Result<(), String> {
    if self.id.trim().is_empty() {
      return Err("route.id cannot be empty".to_string());
    }
    if self.matcher.rule.trim().is_empty() {
      return Err("route.matcher.rule cannot be empty".to_string());
    }
    if self.upstreams.is_empty() {
      return Err("route.upstreams cannot be empty".to_string());
    }

    for middleware in &self.middlewares {
      middleware.validate()?;
    }
    for upstream in &self.upstreams {
      upstream.validate()?;
    }

    Ok(())
  }

  pub fn effective_priority(&self) -> i32 {
    self
      .matcher
      .priority
      .unwrap_or(self.matcher.rule.len() as i32)
  }
}
