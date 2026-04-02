use async_trait::async_trait;
use bytes::Bytes;
use cel::{Program, Value};
use pingora::http::ResponseHeader;
use pingora::proxy::Session;
use pingora::Result;
use serde::Deserialize;

use crate::matcher::cel_session_context::ensure_context;
use crate::middlewares::middleware::middleware_internal_error;
use crate::middlewares::Middleware;
use crate::proxy::ctx::ProxyCtx;

#[derive(Clone, Debug, Deserialize)]
pub struct RespondConfig {
  pub status: u16,
  pub content_type: Option<String>,
  pub body: Option<String>,
  pub body_expression: Option<String>,
  pub rule: Option<String>,
}

impl RespondConfig {
  pub fn validate(&self) -> Result<(), String> {
    if self.status < 100 || self.status > 999 {
      return Err("middleware respond.status must be within [100, 999]".to_string());
    }

    if self.body.is_some() && self.body_expression.is_some() {
      return Err(
        "middleware respond.body and respond.body_expression cannot both be set".to_string(),
      );
    }

    Ok(())
  }
}

pub struct RespondMiddleware {
  status: u16,
  content_type: Option<String>,
  body: Option<String>,
  body_program: Option<Program>,
  cel_program: Option<Program>,
}

impl RespondMiddleware {
  pub fn from_config(cfg: RespondConfig) -> Result<Self, String> {
    cfg.validate()?;

    let cel_program = if let Some(expr) = cfg.rule {
      Some(
        Program::compile(&expr)
          .map_err(|e| format!("failed to compile respond rule '{expr}': {e}"))?,
      )
    } else {
      None
    };

    let body_program = if let Some(expr) = cfg.body_expression {
      Some(
        Program::compile(&expr)
          .map_err(|e| format!("failed to compile respond body_expression '{expr}': {e}"))?,
      )
    } else {
      None
    };

    Ok(Self {
      status: cfg.status,
      content_type: cfg.content_type,
      body: cfg.body,
      body_program,
      cel_program,
    })
  }

  fn should_apply(&self, proxy_ctx: &mut ProxyCtx, session: &Session) -> bool {
    let Some(program) = &self.cel_program else {
      return true;
    };

    let ctx = ensure_context(session, proxy_ctx);
    matches!(program.execute(ctx), Ok(Value::Bool(true)))
  }

  fn eval_body_expression(&self, proxy_ctx: &mut ProxyCtx, session: &Session) -> Result<String> {
    let Some(program) = &self.body_program else {
      return Ok(String::new());
    };

    let ctx = ensure_context(session, proxy_ctx);
    let value = program.execute(ctx).map_err(|e| {
      middleware_internal_error("respond evaluate body_expression failed", e.to_string())
    })?;

    match value {
      Value::String(v) => Ok(v.to_string()),
      Value::Int(v) => Ok(v.to_string()),
      Value::UInt(v) => Ok(v.to_string()),
      Value::Float(v) => Ok(v.to_string()),
      Value::Bool(v) => Ok(v.to_string()),
      other => Err(middleware_internal_error(
        "respond body_expression returned unsupported value",
        format!("expected scalar value, got {other:?}"),
      )),
    }
  }
}

#[async_trait]
impl Middleware for RespondMiddleware {
  async fn request_filter(&self, proxy_ctx: &mut ProxyCtx, session: &mut Session) -> Result<bool> {
    if !self.should_apply(proxy_ctx, session) {
      return Ok(false);
    }

    let body_bytes = if self.body_program.is_some() {
      let body_value = self.eval_body_expression(proxy_ctx, session)?;
      if body_value.is_empty() {
        Bytes::new()
      } else {
        Bytes::from(body_value)
      }
    } else {
      match self.body.as_deref() {
        Some(v) if !v.is_empty() => Bytes::copy_from_slice(v.as_bytes()),
        _ => Bytes::new(),
      }
    };

    let mut resp = ResponseHeader::build(self.status, Some(4)).map_err(|e| {
      middleware_internal_error("respond create response header failed", e.to_string())
    })?;

    if !body_bytes.is_empty() {
      let content_type = self
        .content_type
        .as_deref()
        .unwrap_or("text/plain; charset=utf-8");
      resp
        .insert_header("Content-Type", content_type)
        .map_err(|e| {
          middleware_internal_error("respond insert content-type failed", e.to_string())
        })?;
    }

    resp
      .insert_header("Content-Length", body_bytes.len().to_string())
      .map_err(|e| {
        middleware_internal_error("respond insert content-length failed", e.to_string())
      })?;

    session
      .write_response_header(Box::new(resp), body_bytes.is_empty())
      .await
      .map_err(|e| {
        middleware_internal_error("respond write response header failed", e.to_string())
      })?;

    if !body_bytes.is_empty() {
      session
        .write_response_body(Some(body_bytes), true)
        .await
        .map_err(|e| {
          middleware_internal_error("respond write response body failed", e.to_string())
        })?;
    }

    Ok(true)
  }
}
