use serde::Deserialize;

use crate::config::MiddlewareConfig;
use crate::middlewares::basic_auth::{BasicAuthConfig, BasicAuthMiddleware};
use crate::middlewares::cache::{CacheConfig, CacheMiddleware};
use crate::middlewares::compression::{CompressionConfig, CompressionMiddleware};
use crate::middlewares::cors::{CorsConfig, CorsMiddleware};
use crate::middlewares::health_check::{HealthCheckConfig, HealthCheckMiddleware};
use crate::middlewares::rate_limit::{RateLimitConfig, RateLimitMiddleware};
use crate::middlewares::redirect::{RedirectConfig, RedirectMiddleware};
use crate::middlewares::redirect_https::{RedirectHttpsConfig, RedirectHttpsMiddleware};
use crate::middlewares::request_headers::{RequestHeadersConfig, RequestHeadersMiddleware};
use crate::middlewares::respond::{RespondConfig, RespondMiddleware};
use crate::middlewares::response_headers::{ResponseHeadersConfig, ResponseHeadersMiddleware};
use crate::middlewares::rewrite::{RewriteConfig, RewriteMiddleware};
use crate::middlewares::rewrite_method::{RewriteMethodConfig, RewriteMethodMiddleware};
use crate::middlewares::Middleware;

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MiddlewareType {
  RewriteMethod(RewriteMethodConfig),
  BasicAuth(BasicAuthConfig),
  RequestHeaders(RequestHeadersConfig),
  ResponseHeaders(ResponseHeadersConfig),
  Compression(CompressionConfig),
  HealthCheck(HealthCheckConfig),
  Cache(CacheConfig),
  Rewrite(RewriteConfig),
  Respond(RespondConfig),
  Redirect(RedirectConfig),
  RedirectHttps(RedirectHttpsConfig),
  RateLimit(RateLimitConfig),
  Cors(CorsConfig),
}

pub fn build_middleware(cfg: &MiddlewareConfig) -> Result<Box<dyn Middleware>, String> {
  match &cfg.r#type {
    MiddlewareType::RewriteMethod(v) => {
      Ok(Box::new(RewriteMethodMiddleware::from_config(v.clone())?))
    }
    MiddlewareType::BasicAuth(v) => Ok(Box::new(BasicAuthMiddleware::from_config(v.clone())?)),
    MiddlewareType::RequestHeaders(v) => {
      Ok(Box::new(RequestHeadersMiddleware::from_config(v.clone())?))
    }
    MiddlewareType::ResponseHeaders(v) => {
      Ok(Box::new(ResponseHeadersMiddleware::from_config(v.clone())?))
    }
    MiddlewareType::Compression(v) => Ok(Box::new(CompressionMiddleware::from_config(v.clone())?)),
    MiddlewareType::HealthCheck(v) => Ok(Box::new(HealthCheckMiddleware::from_config(v.clone())?)),
    MiddlewareType::Cache(v) => Ok(Box::new(CacheMiddleware::from_config(v.clone())?)),
    MiddlewareType::Rewrite(v) => Ok(Box::new(RewriteMiddleware::from_config(v.clone())?)),
    MiddlewareType::Respond(v) => Ok(Box::new(RespondMiddleware::from_config(v.clone())?)),
    MiddlewareType::Redirect(v) => Ok(Box::new(RedirectMiddleware::from_config(v.clone())?)),
    MiddlewareType::RedirectHttps(v) => {
      Ok(Box::new(RedirectHttpsMiddleware::from_config(v.clone())?))
    }
    MiddlewareType::RateLimit(v) => Ok(Box::new(RateLimitMiddleware::from_config(v.clone())?)),
    MiddlewareType::Cors(v) => Ok(Box::new(CorsMiddleware::from_config(v.clone())?)),
  }
}
