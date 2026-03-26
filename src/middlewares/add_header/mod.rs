use async_trait::async_trait;
use cel::{Program, Value};
use pingora::proxy::Session;

use crate::matcher::cel_session_context::ensure_context;
use crate::middlewares::Middleware;
use crate::proxy::ctx::ProxyCtx;

#[derive(Clone, Debug)]
pub struct AddHeaderConfig {
  pub name: String,
  pub value: String,
  pub cel: Option<String>,
}

impl AddHeaderConfig {
  pub fn validate(&self) -> Result<(), String> {
    if self.name.trim().is_empty() {
      return Err("middleware AddHeader.name cannot be empty".to_string());
    }
    Ok(())
  }
}

pub struct AddHeaderMiddleware {
  name: String,
  value: String,
  cel_program: Option<Program>,
}

impl AddHeaderMiddleware {
  pub fn from_config(cfg: AddHeaderConfig) -> Result<Self, String> {
    cfg.validate()?;

    let cel_program = if let Some(expr) = cfg.cel {
      Some(
        Program::compile(&expr)
          .map_err(|e| format!("failed to compile add_header CEL '{expr}': {e}"))?,
      )
    } else {
      None
    };

    Ok(Self {
      name: cfg.name,
      value: cfg.value,
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
impl Middleware for AddHeaderMiddleware {
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
      .insert_header(self.name.to_string(), self.value.to_string())
      .map_err(|e| format!("add_header request_filter failed: {e}"))?;

    Ok(false)
  }
}
