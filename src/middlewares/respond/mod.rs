use async_trait::async_trait;
use bytes::Bytes;
use cel::{Program, Value};
use pingora::http::ResponseHeader;
use pingora::proxy::{FailToProxy, Session};
use serde::Deserialize;

use crate::matcher::cel_session_context::ensure_context;
use crate::middlewares::Middleware;
use crate::proxy::ctx::ProxyCtx;

#[derive(Clone, Debug, Deserialize)]
pub struct RespondConfig {
  pub status: u16,
  pub body: Option<String>,
  pub rule: Option<String>,
}

impl RespondConfig {
  pub fn validate(&self) -> Result<(), String> {
    if self.status < 100 || self.status > 999 {
      return Err("middleware respond.status must be within [100, 999]".to_string());
    }
    Ok(())
  }
}

pub struct RespondMiddleware {
  status: u16,
  body: Option<String>,
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

    Ok(Self {
      status: cfg.status,
      body: cfg.body,
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
}

#[async_trait]
impl Middleware for RespondMiddleware {
  async fn request_filter(
    &self,
    proxy_ctx: &mut ProxyCtx,
    session: &mut Session,
  ) -> Result<bool, String> {
    if !self.should_apply(proxy_ctx, session) {
      return Ok(false);
    }

    if let Some(body) = &self.body {
      let mut resp = ResponseHeader::build(self.status, Some(2))
        .map_err(|e| format!("respond create response header failed: {e}"))?;
      resp
        .insert_header("content-type", "text/plain; charset=utf-8")
        .map_err(|e| format!("respond insert content-type failed: {e}"))?;
      resp
        .insert_header("content-length", body.len().to_string())
        .map_err(|e| format!("respond insert content-length failed: {e}"))?;

      session
        .write_response_header(Box::new(resp), false)
        .await
        .map_err(|e| format!("respond write response header failed: {e}"))?;
      session
        .write_response_body(Some(Bytes::copy_from_slice(body.as_bytes())), true)
        .await
        .map_err(|e| format!("respond write response body failed: {e}"))?;
    } else {
      session
        .respond_error(self.status)
        .await
        .map_err(|e| format!("respond write error response failed: {e}"))?;
    }

    Ok(true)
  }

  async fn fail_to_proxy(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _error: &pingora::Error,
  ) -> Result<Option<FailToProxy>, String> {
    Ok(None)
  }
}
