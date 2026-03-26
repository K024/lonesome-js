use std::sync::Arc;

use async_trait::async_trait;
use cel::{Program, Value};
use pingora::proxy::Session;

use crate::matcher::cel_session_context::ensure_context;
use crate::middlewares::Middleware;
use crate::proxy::ctx::ProxyCtx;

#[derive(Clone, Debug)]
pub struct RemoveHeaderConfig {
  pub name: String,
  pub cel: Option<String>,
}

impl RemoveHeaderConfig {
  pub fn validate(&self) -> Result<(), String> {
    if self.name.trim().is_empty() {
      return Err("middleware RemoveHeader.name cannot be empty".to_string());
    }
    Ok(())
  }
}

pub struct RemoveHeaderMiddleware {
  name: Arc<str>,
  cel_program: Option<Program>,
}

impl RemoveHeaderMiddleware {
  pub fn from_config(cfg: RemoveHeaderConfig) -> Result<Self, String> {
    cfg.validate()?;

    let cel_program = if let Some(expr) = cfg.cel {
      Some(
        Program::compile(&expr)
          .map_err(|e| format!("failed to compile remove_header CEL '{expr}': {e}"))?,
      )
    } else {
      None
    };

    Ok(Self {
      name: Arc::from(cfg.name),
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
impl Middleware for RemoveHeaderMiddleware {
  async fn request_filter(
    &self,
    proxy_ctx: &mut ProxyCtx,
    session: &mut Session,
  ) -> Result<bool, String> {
    if !self.should_apply(proxy_ctx, session) {
      return Ok(false);
    }

    let name = self.name.to_string();
    session.as_downstream_mut().req_header_mut().remove_header(&name);
    Ok(false)
  }
}
