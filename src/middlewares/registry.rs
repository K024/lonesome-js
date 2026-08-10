use serde::Deserialize;

use crate::config::MiddlewareConfig;
use crate::middlewares::access_log::{AccessLogConfig, AccessLogMiddleware};
use crate::middlewares::basic_auth::{BasicAuthConfig, BasicAuthMiddleware};
use crate::middlewares::cache::{CacheConfig, CacheMiddleware};
use crate::middlewares::compression::{CompressionConfig, CompressionMiddleware};
use crate::middlewares::cors::{CorsConfig, CorsMiddleware};
use crate::middlewares::health_check::{HealthCheckConfig, HealthCheckMiddleware};
use crate::middlewares::interceptor::{InterceptorConfig, InterceptorMiddleware};
use crate::middlewares::jwt::{JwtConfig, JwtMiddleware};
use crate::middlewares::rate_limit::{RateLimitConfig, RateLimitMiddleware};
use crate::middlewares::redirect::{RedirectConfig, RedirectMiddleware};
use crate::middlewares::redirect_https::{RedirectHttpsConfig, RedirectHttpsMiddleware};
use crate::middlewares::request_headers::{RequestHeadersConfig, RequestHeadersMiddleware};
use crate::middlewares::respond::{RespondConfig, RespondMiddleware};
use crate::middlewares::response_headers::{ResponseHeadersConfig, ResponseHeadersMiddleware};
use crate::middlewares::rewrite::{RewriteConfig, RewriteMiddleware};
use crate::middlewares::rewrite_error_page::{RewriteErrorPageConfig, RewriteErrorPageMiddleware};
use crate::middlewares::rewrite_method::{RewriteMethodConfig, RewriteMethodMiddleware};
use crate::middlewares::set_variable::{SetVariableConfig, SetVariableMiddleware};
use crate::middlewares::Middleware;

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MiddlewareType {
  AccessLog(AccessLogConfig),
  BasicAuth(BasicAuthConfig),
  Cache(CacheConfig),
  Compression(CompressionConfig),
  Cors(CorsConfig),
  HealthCheck(HealthCheckConfig),
  Interceptor(InterceptorConfig),
  Jwt(JwtConfig),
  RateLimit(RateLimitConfig),
  Redirect(RedirectConfig),
  RedirectHttps(RedirectHttpsConfig),
  RequestHeaders(RequestHeadersConfig),
  Respond(RespondConfig),
  ResponseHeaders(ResponseHeadersConfig),
  Rewrite(RewriteConfig),
  RewriteErrorPage(RewriteErrorPageConfig),
  RewriteMethod(RewriteMethodConfig),
  SetVariable(SetVariableConfig),
}

pub fn build_middleware(cfg: &MiddlewareConfig) -> Result<Box<dyn Middleware>, String> {
  match &cfg.r#type {
    MiddlewareType::AccessLog(v) => Ok(Box::new(AccessLogMiddleware::from_config(v.clone())?)),
    MiddlewareType::BasicAuth(v) => Ok(Box::new(BasicAuthMiddleware::from_config(v.clone())?)),
    MiddlewareType::Cache(v) => Ok(Box::new(CacheMiddleware::from_config(v.clone())?)),
    MiddlewareType::Compression(v) => Ok(Box::new(CompressionMiddleware::from_config(v.clone())?)),
    MiddlewareType::Cors(v) => Ok(Box::new(CorsMiddleware::from_config(v.clone())?)),
    MiddlewareType::HealthCheck(v) => Ok(Box::new(HealthCheckMiddleware::from_config(v.clone())?)),
    MiddlewareType::Interceptor(v) => Ok(Box::new(InterceptorMiddleware::from_config(v.clone())?)),
    MiddlewareType::Jwt(v) => Ok(Box::new(JwtMiddleware::from_config(v.clone())?)),
    MiddlewareType::RateLimit(v) => Ok(Box::new(RateLimitMiddleware::from_config(v.clone())?)),
    MiddlewareType::Redirect(v) => Ok(Box::new(RedirectMiddleware::from_config(v.clone())?)),
    MiddlewareType::RedirectHttps(v) => {
      Ok(Box::new(RedirectHttpsMiddleware::from_config(v.clone())?))
    }
    MiddlewareType::RequestHeaders(v) => {
      Ok(Box::new(RequestHeadersMiddleware::from_config(v.clone())?))
    }
    MiddlewareType::Respond(v) => Ok(Box::new(RespondMiddleware::from_config(v.clone())?)),
    MiddlewareType::ResponseHeaders(v) => {
      Ok(Box::new(ResponseHeadersMiddleware::from_config(v.clone())?))
    }
    MiddlewareType::Rewrite(v) => Ok(Box::new(RewriteMiddleware::from_config(v.clone())?)),
    MiddlewareType::RewriteErrorPage(v) => {
      Ok(Box::new(RewriteErrorPageMiddleware::from_config(v.clone())?))
    }
    MiddlewareType::RewriteMethod(v) => {
      Ok(Box::new(RewriteMethodMiddleware::from_config(v.clone())?))
    }
    MiddlewareType::SetVariable(v) => Ok(Box::new(SetVariableMiddleware::from_config(v.clone())?)),
  }
}
