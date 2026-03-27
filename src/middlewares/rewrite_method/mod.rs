use async_trait::async_trait;
use cel::{Program, Value};
use pingora::http::Method;
use pingora::proxy::Session;
use serde::Deserialize;

use crate::matcher::cel_session_context::ensure_context;
use crate::middlewares::Middleware;
use crate::proxy::ctx::ProxyCtx;

#[derive(Clone, Debug, Deserialize)]
pub struct RewriteMethodConfig {
  pub method: String,
  pub rule: Option<String>,
}

impl RewriteMethodConfig {
  pub fn validate(&self) -> Result<(), String> {
    if self.method.trim().is_empty() {
      return Err("middleware rewrite_method.method cannot be empty".to_string());
    }

    Method::from_bytes(self.method.as_bytes())
      .map_err(|e| format!("middleware rewrite_method.method is invalid: {e}"))?;

    Ok(())
  }
}

pub struct RewriteMethodMiddleware {
  method: Method,
  cel_program: Option<Program>,
}

impl RewriteMethodMiddleware {
  pub fn from_config(cfg: RewriteMethodConfig) -> Result<Self, String> {
    cfg.validate()?;

    let method = Method::from_bytes(cfg.method.as_bytes())
      .map_err(|e| format!("middleware rewrite_method.method is invalid: {e}"))?;

    let cel_program = if let Some(expr) = cfg.rule {
      Some(
        Program::compile(&expr)
          .map_err(|e| format!("failed to compile rewrite_method rule '{expr}': {e}"))?,
      )
    } else {
      None
    };

    Ok(Self { method, cel_program })
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
impl Middleware for RewriteMethodMiddleware {
  async fn request_filter(
    &self,
    proxy_ctx: &mut ProxyCtx,
    session: &mut Session,
  ) -> Result<bool, String> {
    if !self.should_apply(proxy_ctx, session) {
      return Ok(false);
    }

    session
      .as_downstream_mut()
      .req_header_mut()
      .set_method(self.method.clone());

    Ok(false)
  }
}
