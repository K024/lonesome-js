use async_trait::async_trait;
use cel::{Program, Value};
use pingora::http::RequestHeader;
use pingora::proxy::Session;
use pingora::Result;
use serde::Deserialize;

use crate::matcher::cel_session_context::ensure_context;
use crate::middlewares::middleware::middleware_internal_error;
use crate::middlewares::Middleware;
use crate::proxy::ctx::ProxyCtx;

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum RequestHeadersActionConfig {
  Append { value: String },
  Set { value: String },
  SetDefault { value: String },
  Remove,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RequestHeadersConfig {
  pub name: String,
  #[serde(flatten)]
  pub action: RequestHeadersActionConfig,
  pub rule: Option<String>,
}

impl RequestHeadersConfig {
  pub fn validate(&self) -> Result<(), String> {
    if self.name.trim().is_empty() {
      return Err("middleware request_headers.name cannot be empty".to_string());
    }

    match &self.action {
      RequestHeadersActionConfig::Append { value }
      | RequestHeadersActionConfig::Set { value }
      | RequestHeadersActionConfig::SetDefault { value } => {
        if value.is_empty() {
          return Err("middleware request_headers.value cannot be empty".to_string());
        }
      }
      RequestHeadersActionConfig::Remove => {}
    }

    Ok(())
  }
}

enum RequestHeadersAction {
  Append { value: String },
  Set { value: String },
  SetDefault { value: String },
  Remove,
}

pub struct RequestHeadersMiddleware {
  name: String,
  action: RequestHeadersAction,
  cel_program: Option<Program>,
}

impl RequestHeadersMiddleware {
  pub fn from_config(cfg: RequestHeadersConfig) -> Result<Self, String> {
    cfg.validate()?;

    let action = match cfg.action {
      RequestHeadersActionConfig::Append { value } => RequestHeadersAction::Append { value },
      RequestHeadersActionConfig::Set { value } => RequestHeadersAction::Set { value },
      RequestHeadersActionConfig::SetDefault { value } => {
        RequestHeadersAction::SetDefault { value }
      }
      RequestHeadersActionConfig::Remove => RequestHeadersAction::Remove,
    };

    let cel_program = if let Some(expr) = cfg.rule {
      Some(
        Program::compile(&expr)
          .map_err(|e| format!("failed to compile request_headers rule '{expr}': {e}"))?,
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

  fn apply(&self, upstream_request: &mut RequestHeader) -> Result<()> {
    match &self.action {
      RequestHeadersAction::Append { value } => upstream_request
        .append_header(self.name.clone(), value.clone())
        .map(|_| ())
        .map_err(|e| middleware_internal_error("request_headers append failed", e.to_string())),
      RequestHeadersAction::Set { value } => upstream_request
        .insert_header(self.name.clone(), value.clone())
        .map_err(|e| middleware_internal_error("request_headers set failed", e.to_string())),
      RequestHeadersAction::SetDefault { value } => {
        if upstream_request.headers.get(self.name.as_str()).is_none() {
          upstream_request
            .insert_header(self.name.clone(), value.clone())
            .map_err(|e| {
              middleware_internal_error("request_headers set_default failed", e.to_string())
            })?;
        }
        Ok(())
      }
      RequestHeadersAction::Remove => {
        upstream_request.remove_header(self.name.as_str());
        Ok(())
      }
    }
  }
}

#[async_trait]
impl Middleware for RequestHeadersMiddleware {
  async fn upstream_request_filter(
    &self,
    proxy_ctx: &mut ProxyCtx,
    session: &mut Session,
    upstream_request: &mut RequestHeader,
  ) -> Result<()> {
    if !self.should_apply(proxy_ctx, session) {
      return Ok(());
    }

    self.apply(upstream_request)
  }
}
