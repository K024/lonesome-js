use async_trait::async_trait;
use bytes::Bytes;
use pingora::http::ResponseHeader;
use pingora::proxy::Session;
use pingora::Result;
use serde::Deserialize;
use serde_json::Value as JsonValue;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::interceptor::run_interceptor;
use crate::interceptor::types::{InterceptorAction, InterceptorResult};
use crate::middlewares::middleware::middleware_internal_error;
use crate::middlewares::Middleware;
use crate::proxy::ctx::ProxyCtx;

#[derive(Clone, Debug, Deserialize)]
pub struct InterceptorConfig {
  pub key: String,
}

impl InterceptorConfig {
  pub fn validate(&self) -> Result<(), String> {
    if self.key.trim().is_empty() {
      return Err("middleware interceptor.key cannot be empty".to_string());
    }
    Ok(())
  }
}

pub struct InterceptorMiddleware {
  key: String,
  seq: AtomicU64,
}

impl InterceptorMiddleware {
  pub fn from_config(cfg: InterceptorConfig) -> Result<Self, String> {
    cfg.validate()?;
    Ok(Self {
      key: cfg.key,
      seq: AtomicU64::new(0),
    })
  }

  fn next_request_id(&self) -> String {
    let n = self.seq.fetch_add(1, Ordering::Relaxed);
    format!("{}:req:{n}", self.key)
  }

  fn parse_result(value: JsonValue) -> Result<InterceptorResult> {
    if value.is_null() {
      return Ok(InterceptorResult {
        action: InterceptorAction::Continue,
        status: None,
        body: None,
        content_type: None,
      });
    }

    let Some(obj) = value.as_object() else {
      return Err(middleware_internal_error(
        "interceptor invalid result",
        "expected null/undefined or object result",
      ));
    };

    let action = obj
      .get("action")
      .and_then(|v| v.as_str())
      .unwrap_or("continue");

    match action {
      "continue" => Ok(InterceptorResult {
        action: InterceptorAction::Continue,
        status: None,
        body: None,
        content_type: None,
      }),
      "respond" => {
        let status = match obj.get("status").and_then(|v| v.as_u64()) {
          Some(v) if (100..=999).contains(&v) => v as u16,
          Some(_) => {
            return Err(middleware_internal_error(
              "interceptor invalid status",
              "status must be within [100, 999]",
            ));
          }
          None => 200,
        };

        let body = obj
          .get("body")
          .and_then(|v| v.as_str())
          .map(|v| v.to_string());
        let content_type = obj
          .get("contentType")
          .or_else(|| obj.get("content_type"))
          .and_then(|v| v.as_str())
          .map(|v| v.to_string());

        Ok(InterceptorResult {
          action: InterceptorAction::Respond,
          status: Some(status),
          body,
          content_type,
        })
      }
      other => Err(middleware_internal_error(
        "interceptor invalid action",
        format!("unsupported action '{other}'"),
      )),
    }
  }

  async fn write_short_response(session: &mut Session, result: InterceptorResult) -> Result<bool> {
    let status = result.status.unwrap_or(200);
    let body_bytes = result.body.map(Bytes::from).unwrap_or_else(Bytes::new);

    let mut resp = ResponseHeader::build(status, Some(4)).map_err(|e| {
      middleware_internal_error("interceptor create response header failed", e.to_string())
    })?;

    if !body_bytes.is_empty() {
      let content_type = result
        .content_type
        .as_deref()
        .unwrap_or("text/plain; charset=utf-8");
      resp
        .insert_header("Content-Type", content_type)
        .map_err(|e| {
          middleware_internal_error("interceptor insert content-type failed", e.to_string())
        })?;
    }

    resp
      .insert_header("Content-Length", body_bytes.len().to_string())
      .map_err(|e| {
        middleware_internal_error("interceptor insert content-length failed", e.to_string())
      })?;

    session
      .write_response_header(Box::new(resp), body_bytes.is_empty())
      .await
      .map_err(|e| {
        middleware_internal_error("interceptor write response header failed", e.to_string())
      })?;

    if !body_bytes.is_empty() {
      session
        .write_response_body(Some(body_bytes), true)
        .await
        .map_err(|e| {
          middleware_internal_error("interceptor write response body failed", e.to_string())
        })?;
    }

    Ok(true)
  }
}

#[async_trait]
impl Middleware for InterceptorMiddleware {
  async fn request_filter(&self, _proxy_ctx: &mut ProxyCtx, session: &mut Session) -> Result<bool> {
    let req = session.req_header();
    let method = req.method.as_str().to_string();
    let path = req
      .uri
      .path_and_query()
      .map(|v| v.as_str().to_string())
      .unwrap_or_else(|| req.uri.path().to_string());

    let request_id = self.next_request_id();

    let Some(raw_result) = run_interceptor(&self.key, request_id, method, path).await? else {
      return Ok(false);
    };

    let result = Self::parse_result(raw_result)?;
    match result.action {
      InterceptorAction::Continue => Ok(false),
      InterceptorAction::Respond => Self::write_short_response(session, result).await,
    }
  }
}
