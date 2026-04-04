use napi_derive::napi;

use crate::bindings::middleware_config::MiddlewareConfig;
use crate::bindings::upstream_config::{LoadBalancerConfig, UpstreamConfig};
use crate::config::{RouteConfig as CoreRouteConfig, RouteMatcherConfig as CoreRouteMatcherConfig};

#[napi(object, js_name = "RouteMatcherConfig")]
pub struct RouteMatcherConfig {
  pub rule: String,
  pub priority: Option<i32>,
}

#[napi(object)]
pub struct RouteConfig {
  pub id: String,
  pub matcher: RouteMatcherConfig,
  pub middlewares: Vec<MiddlewareConfig>,
  pub upstreams: Vec<UpstreamConfig>,
  pub load_balancer: Option<LoadBalancerConfig>,
}

impl TryFrom<RouteConfig> for CoreRouteConfig {
  type Error = String;

  fn try_from(value: RouteConfig) -> Result<Self, Self::Error> {
    let middlewares = value
      .middlewares
      .into_iter()
      .map(TryInto::try_into)
      .collect::<Result<Vec<_>, String>>()?;

    let upstreams = value
      .upstreams
      .into_iter()
      .map(TryInto::try_into)
      .collect::<Result<Vec<_>, String>>()?;

    let load_balancer = value.load_balancer.map(TryInto::try_into).transpose()?;

    Ok(CoreRouteConfig {
      id: value.id,
      matcher: CoreRouteMatcherConfig {
        rule: value.matcher.rule,
        priority: value.matcher.priority,
      },
      middlewares,
      upstreams,
      load_balancer,
    })
  }
}
