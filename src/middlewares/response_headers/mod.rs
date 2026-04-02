use async_trait::async_trait;
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
#[serde(rename_all = "snake_case")]
pub enum ResponseHeadersActionConfig {
  Append,
  Set,
  SetDefault,
  Remove,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ResponseHeadersConfig {
  pub name: String,
  pub action: ResponseHeadersActionConfig,
  pub value: Option<String>,
  pub expression: Option<String>,
  pub rule: Option<String>,
}

impl ResponseHeadersConfig {
  pub fn validate(&self) -> Result<(), String> {
    if self.name.trim().is_empty() {
      return Err("middleware response_headers.name cannot be empty".to_string());
    }

    match self.action {
      ResponseHeadersActionConfig::Append
      | ResponseHeadersActionConfig::Set
      | ResponseHeadersActionConfig::SetDefault => match (&self.value, &self.expression) {
        (Some(_), Some(_)) => {
          return Err(
            "middleware response_headers.value and response_headers.expression cannot both be set"
              .to_string(),
          );
        }
        (None, None) => {
          return Err(
            "middleware response_headers.value or response_headers.expression is required"
              .to_string(),
          );
        }
        (Some(value), None) => {
          if value.is_empty() {
            return Err("middleware response_headers.value cannot be empty".to_string());
          }
        }
        (None, Some(expression)) => {
          if expression.trim().is_empty() {
            return Err("middleware response_headers.expression cannot be empty".to_string());
          }
        }
      },
      ResponseHeadersActionConfig::Remove => {
        if self.value.is_some() || self.expression.is_some() {
          return Err(
            "middleware response_headers.value/expression is not allowed for remove action"
              .to_string(),
          );
        }
      }
    }

    Ok(())
  }
}

enum ResponseHeadersValue {
  Value(String),
  Expression(Program),
}

enum ResponseHeadersAction {
  Append { value: ResponseHeadersValue },
  Set { value: ResponseHeadersValue },
  SetDefault { value: ResponseHeadersValue },
  Remove,
}

pub struct ResponseHeadersMiddleware {
  name: String,
  action: ResponseHeadersAction,
  cel_program: Option<Program>,
}

impl ResponseHeadersMiddleware {
  fn from_value_fields(
    value: Option<String>,
    expression: Option<String>,
  ) -> Result<ResponseHeadersValue, String> {
    match (value, expression) {
      (Some(value), None) => Ok(ResponseHeadersValue::Value(value)),
      (None, Some(expression)) => {
        let program = Program::compile(&expression).map_err(|e| {
          format!("failed to compile response_headers expression '{expression}': {e}")
        })?;
        Ok(ResponseHeadersValue::Expression(program))
      }
      _ => Err(
        "middleware response_headers.value or response_headers.expression is required".to_string(),
      ),
    }
  }

  pub fn from_config(cfg: ResponseHeadersConfig) -> Result<Self, String> {
    cfg.validate()?;

    let action = match cfg.action {
      ResponseHeadersActionConfig::Append => ResponseHeadersAction::Append {
        value: Self::from_value_fields(cfg.value.clone(), cfg.expression.clone())?,
      },
      ResponseHeadersActionConfig::Set => ResponseHeadersAction::Set {
        value: Self::from_value_fields(cfg.value.clone(), cfg.expression.clone())?,
      },
      ResponseHeadersActionConfig::SetDefault => ResponseHeadersAction::SetDefault {
        value: Self::from_value_fields(cfg.value.clone(), cfg.expression.clone())?,
      },
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

  fn value_string(
    &self,
    proxy_ctx: &mut ProxyCtx,
    session: &Session,
    value: &ResponseHeadersValue,
  ) -> Result<String> {
    match value {
      ResponseHeadersValue::Value(v) => Ok(v.clone()),
      ResponseHeadersValue::Expression(program) => {
        let ctx = ensure_context(session, proxy_ctx);
        let v = program.execute(ctx).map_err(|e| {
          middleware_internal_error(
            "response_headers expression execution failed",
            e.to_string(),
          )
        })?;
        match v {
          Value::String(s) => Ok(s.to_string()),
          other => Err(middleware_internal_error(
            "response_headers expression must return string",
            format!("got {other:?}"),
          )),
        }
      }
    }
  }

  fn apply(
    &self,
    proxy_ctx: &mut ProxyCtx,
    session: &Session,
    response: &mut ResponseHeader,
  ) -> Result<()> {
    match &self.action {
      ResponseHeadersAction::Append { value } => response
        .append_header(
          self.name.clone(),
          self.value_string(proxy_ctx, session, value)?,
        )
        .map(|_| ())
        .map_err(|e| middleware_internal_error("response_headers append failed", e.to_string())),
      ResponseHeadersAction::Set { value } => response
        .insert_header(
          self.name.clone(),
          self.value_string(proxy_ctx, session, value)?,
        )
        .map_err(|e| middleware_internal_error("response_headers set failed", e.to_string())),
      ResponseHeadersAction::SetDefault { value } => {
        if response.headers.get(self.name.as_str()).is_none() {
          response
            .insert_header(
              self.name.clone(),
              self.value_string(proxy_ctx, session, value)?,
            )
            .map_err(|e| {
              middleware_internal_error("response_headers set_default failed", e.to_string())
            })?;
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
  ) -> Result<()> {
    if !self.should_apply(proxy_ctx, session) {
      return Ok(());
    }

    self.apply(proxy_ctx, session, upstream_response)
  }
}
