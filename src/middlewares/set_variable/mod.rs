use async_trait::async_trait;
use cel::{Program, Value};
use pingora::http::ResponseHeader;
use pingora::proxy::Session;
use pingora::Result;
use serde::Deserialize;

use crate::matcher::cel_session_context::{ensure_context, ensure_context_mut};
use crate::middlewares::middleware::middleware_internal_error;
use crate::middlewares::Middleware;
use crate::proxy::ctx::ProxyCtx;

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SetVariableStageConfig {
  #[default]
  Request,
  UpstreamResponse,
  Response,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SetVariableConfig {
  pub name: String,
  pub expression: String,
  #[serde(default)]
  pub stage: SetVariableStageConfig,
  pub rule: Option<String>,
}

impl SetVariableConfig {
  pub fn validate(&self) -> Result<(), String> {
    if self.name.trim().is_empty() {
      return Err("middleware set_variable.name cannot be empty".to_string());
    }
    if self.expression.trim().is_empty() {
      return Err("middleware set_variable.expression cannot be empty".to_string());
    }
    Ok(())
  }
}

pub struct SetVariableMiddleware {
  name: String,
  stage: SetVariableStageConfig,
  value_program: Program,
  rule_program: Option<Program>,
}

impl SetVariableMiddleware {
  pub fn from_config(cfg: SetVariableConfig) -> Result<Self, String> {
    cfg.validate()?;

    let value_program = Program::compile(&cfg.expression).map_err(|e| {
      format!(
        "failed to compile set_variable expression '{}': {e}",
        cfg.expression
      )
    })?;

    let rule_program = if let Some(expr) = cfg.rule {
      Some(
        Program::compile(&expr)
          .map_err(|e| format!("failed to compile set_variable rule '{expr}': {e}"))?,
      )
    } else {
      None
    };

    Ok(Self {
      name: cfg.name,
      stage: cfg.stage,
      value_program,
      rule_program,
    })
  }

  fn should_apply(&self, proxy_ctx: &mut ProxyCtx, session: &Session) -> bool {
    let Some(program) = &self.rule_program else {
      return true;
    };

    let ctx = ensure_context(session, proxy_ctx);
    matches!(program.execute(ctx), Ok(Value::Bool(true)))
  }
}

impl SetVariableMiddleware {
  fn apply(&self, proxy_ctx: &mut ProxyCtx, session: &Session) -> Result<()> {
    if !self.should_apply(proxy_ctx, session) {
      return Ok(());
    }

    let value = {
      let ctx = ensure_context(session, proxy_ctx);
      self.value_program.execute(ctx).map_err(|e| {
        middleware_internal_error("set_variable expression execution failed", e.to_string())
      })?
    };

    let ctx = ensure_context_mut(session, proxy_ctx);
    ctx.add_variable_from_value(self.name.as_str(), value);

    Ok(())
  }
}

#[async_trait]
impl Middleware for SetVariableMiddleware {
  async fn request_filter(&self, proxy_ctx: &mut ProxyCtx, session: &mut Session) -> Result<bool> {
    if matches!(self.stage, SetVariableStageConfig::Request) {
      self.apply(proxy_ctx, session)?;
    }

    Ok(false)
  }

  async fn upstream_response_filter(
    &self,
    proxy_ctx: &mut ProxyCtx,
    session: &mut Session,
    _upstream_response: &mut ResponseHeader,
  ) -> Result<()> {
    if matches!(self.stage, SetVariableStageConfig::UpstreamResponse) {
      self.apply(proxy_ctx, session)?;
    }

    Ok(())
  }

  async fn response_filter(
    &self,
    proxy_ctx: &mut ProxyCtx,
    session: &mut Session,
    _upstream_response: &mut ResponseHeader,
  ) -> Result<()> {
    if matches!(self.stage, SetVariableStageConfig::Response) {
      self.apply(proxy_ctx, session)?;
    }

    Ok(())
  }
}
