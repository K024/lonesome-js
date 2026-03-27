use async_trait::async_trait;
use cel::{Program, Value};
use pingora::http::ResponseHeader;
use pingora::proxy::Session;
use serde::Deserialize;

use crate::matcher::cel_session_context::ensure_context;
use crate::middlewares::Middleware;
use crate::proxy::ctx::ProxyCtx;

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ResponseHeadersActionConfig {
  Append { value: String },
  Set { value: String },
  SetDefault { value: String },
  Remove,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ResponseHeadersConfig {
  pub name: String,
  #[serde(flatten)]
  pub action: ResponseHeadersActionConfig,
  pub rule: Option<String>,
}

impl ResponseHeadersConfig {
  pub fn validate(&self) -> Result<(), String> {
    if self.name.trim().is_empty() {
      return Err("middleware response_headers.name cannot be empty".to_string());
    }

    match &self.action {
      ResponseHeadersActionConfig::Append { value }
      | ResponseHeadersActionConfig::Set { value }
      | ResponseHeadersActionConfig::SetDefault { value } => {
        if value.is_empty() {
          return Err("middleware response_headers.value cannot be empty".to_string());
        }
      }
      ResponseHeadersActionConfig::Remove => {}
    }

    Ok(())
  }
}

enum ResponseHeadersAction {
  Append { value: String },
  Set { value: String },
  SetDefault { value: String },
  Remove,
}

pub struct ResponseHeadersMiddleware {
  name: String,
  action: ResponseHeadersAction,
  cel_program: Option<Program>,
}

impl ResponseHeadersMiddleware {
  pub fn from_config(cfg: ResponseHeadersConfig) -> Result<Self, String> {
    cfg.validate()?;

    let action = match cfg.action {
      ResponseHeadersActionConfig::Append { value } => ResponseHeadersAction::Append { value },
      ResponseHeadersActionConfig::Set { value } => ResponseHeadersAction::Set { value },
      ResponseHeadersActionConfig::SetDefault { value } => ResponseHeadersAction::SetDefault { value },
      ResponseHeadersActionConfig::Remove => ResponseHeadersAction::Remove,
    };

    let cel_program = if let Some(expr) = cfg.rule {
      Some(
        Program::compile(&expr)
          .map_err(|e| format!("failed to compile response_headers rule '{expr}': {e}"))?,
      )
    } else {
      None
    };

    Ok(Self {
      name: cfg.name,
      action,
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

  fn apply(&self, response: &mut ResponseHeader) -> Result<(), String> {
    match &self.action {
      ResponseHeadersAction::Append { value } => response
        .append_header(self.name.clone(), value.clone())
        .map(|_| ())
        .map_err(|e| format!("response_headers append failed: {e}")),
      ResponseHeadersAction::Set { value } => response
        .insert_header(self.name.clone(), value.clone())
        .map_err(|e| format!("response_headers set failed: {e}")),
      ResponseHeadersAction::SetDefault { value } => {
        if response.headers.get(self.name.as_str()).is_none() {
          response
            .insert_header(self.name.clone(), value.clone())
            .map_err(|e| format!("response_headers set_default failed: {e}"))?;
        }
        Ok(())
      }
      ResponseHeadersAction::Remove => {
        response.remove_header(self.name.as_str());
        Ok(())
      }
    }
  }
}

#[async_trait]
impl Middleware for ResponseHeadersMiddleware {
  async fn response_filter(
    &self,
    proxy_ctx: &mut ProxyCtx,
    session: &mut Session,
    upstream_response: &mut ResponseHeader,
  ) -> Result<(), String> {
    if !self.should_apply(proxy_ctx, session) {
      return Ok(());
    }

    self.apply(upstream_response)
  }
}
