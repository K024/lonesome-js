use napi_derive::napi;

use crate::bindings::middleware_config::NapiMiddlewareConfig;
use crate::bindings::upstream_config::{NapiLoadBalancerConfig, NapiUpstreamConfig};
use crate::config::{RouteConfig, RouteMatcherConfig};

#[napi(object)]
pub struct NapiRouteMatcherConfig {
  pub cel: String,
  pub priority: Option<i32>,
}

#[napi(object)]
pub struct NapiRouteConfig {
  pub id: String,
  pub matcher: NapiRouteMatcherConfig,
  pub middlewares: Vec<NapiMiddlewareConfig>,
  pub upstreams: Vec<NapiUpstreamConfig>,
  pub load_balancer: Option<NapiLoadBalancerConfig>,
}

impl TryFrom<NapiRouteConfig> for RouteConfig {
  type Error = String;

  fn try_from(value: NapiRouteConfig) -> Result<Self, Self::Error> {
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

    let load_balancer = value
      .load_balancer
      .map(TryInto::try_into)
      .transpose()?;

    Ok(RouteConfig {
      id: value.id,
      matcher: RouteMatcherConfig {
        cel: value.matcher.cel,
        priority: value.matcher.priority,
      },
      middlewares,
      upstreams,
      load_balancer,
    })
  }
}
