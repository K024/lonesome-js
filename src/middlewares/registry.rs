use serde::Deserialize;

use crate::config::MiddlewareConfig;
use crate::middlewares::request_headers::{RequestHeadersConfig, RequestHeadersMiddleware};
use crate::middlewares::response_headers::{ResponseHeadersConfig, ResponseHeadersMiddleware};
use crate::middlewares::rewrite_method::{RewriteMethodConfig, RewriteMethodMiddleware};
use crate::middlewares::Middleware;

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MiddlewareType {
  RewriteMethod(RewriteMethodConfig),
  RequestHeaders(RequestHeadersConfig),
  ResponseHeaders(ResponseHeadersConfig),
}

pub fn build_middleware(cfg: &MiddlewareConfig) -> Result<Box<dyn Middleware>, String> {
  match &cfg.r#type {
    MiddlewareType::RewriteMethod(v) => {
      Ok(Box::new(RewriteMethodMiddleware::from_config(v.clone())?))
    }
    MiddlewareType::RequestHeaders(v) => {
      Ok(Box::new(RequestHeadersMiddleware::from_config(v.clone())?))
    }
    MiddlewareType::ResponseHeaders(v) => {
      Ok(Box::new(ResponseHeadersMiddleware::from_config(v.clone())?))
    }
  }
}
