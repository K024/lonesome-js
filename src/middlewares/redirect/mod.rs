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
#[serde(tag = "target_mode", rename_all = "snake_case")]
pub enum RedirectTargetConfig {
  Static { target: String },
  Cel { expression: String },
  RegexReplace { find: String, replace: String },
}

#[derive(Clone, Debug, Deserialize)]
pub struct RedirectConfig {
  pub code: u16,
  #[serde(flatten)]
  pub target: RedirectTargetConfig,
  pub rule: Option<String>,
}

impl RedirectConfig {
  pub fn validate(&self) -> Result<(), String> {
    if !matches!(self.code, 301 | 302 | 303 | 307 | 308) {
      return Err("middleware redirect.code must be one of 301,302,303,307,308".to_string());
    }

    match &self.target {
      RedirectTargetConfig::Static { target } => {
        if target.trim().is_empty() {
          return Err("middleware redirect.target cannot be empty".to_string());
        }
      }
      RedirectTargetConfig::Cel { expression } => {
        if expression.trim().is_empty() {
          return Err("middleware redirect.expression cannot be empty".to_string());
        }
      }
      RedirectTargetConfig::RegexReplace { find, .. } => {
        if find.is_empty() {
          return Err("middleware redirect.find cannot be empty".to_string());
        }
      }
    }

    Ok(())
  }
}

enum RedirectTarget {
  Static(String),
  Cel(Program),
  RegexReplace {
    regex: regex::Regex,
    replace: String,
  },
}

pub struct RedirectMiddleware {
  code: u16,
  target: RedirectTarget,
  cel_program: Option<Program>,
}

impl RedirectMiddleware {
  pub fn from_config(cfg: RedirectConfig) -> Result<Self, String> {
    cfg.validate()?;

    let target = match cfg.target {
      RedirectTargetConfig::Static { target } => RedirectTarget::Static(target),
      RedirectTargetConfig::Cel { expression } => {
        let program = Program::compile(&expression)
          .map_err(|e| format!("failed to compile redirect expression '{expression}': {e}"))?;
        RedirectTarget::Cel(program)
      }
      RedirectTargetConfig::RegexReplace { find, replace } => {
        let regex = regex::Regex::new(&find)
          .map_err(|e| format!("middleware redirect.find is invalid regex: {e}"))?;
        RedirectTarget::RegexReplace { regex, replace }
      }
    };

    let cel_program = if let Some(expr) = cfg.rule {
      Some(
        Program::compile(&expr)
          .map_err(|e| format!("failed to compile redirect rule '{expr}': {e}"))?,
      )
    } else {
      None
    };

    Ok(Self {
      code: cfg.code,
      target,
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

  fn target_location(&self, proxy_ctx: &mut ProxyCtx, session: &Session) -> Option<String> {
    match &self.target {
      RedirectTarget::Static(v) => Some(v.clone()),
      RedirectTarget::Cel(program) => {
        let ctx = ensure_context(session, proxy_ctx);
        match program.execute(ctx) {
          Ok(Value::String(v)) => Some(v.to_string()),
          _ => None,
        }
      }
      RedirectTarget::RegexReplace { regex, replace } => {
        let req = session.req_header();
        let input = req.uri.path_and_query().map(|v| v.as_str()).unwrap_or("/");
        if !regex.is_match(input) {
          return None;
        }
        Some(regex.replace(input, replace.as_str()).into_owned())
      }
    }
  }
}

#[async_trait]
impl Middleware for RedirectMiddleware {
  async fn request_filter(&self, proxy_ctx: &mut ProxyCtx, session: &mut Session) -> Result<bool> {
    if !self.should_apply(proxy_ctx, session) {
      return Ok(false);
    }

    let Some(location) = self.target_location(proxy_ctx, session) else {
      return Ok(false);
    };

    let mut resp = ResponseHeader::build(self.code, Some(2)).map_err(|e| {
      middleware_internal_error("redirect create response header failed", e.to_string())
    })?;
    resp
      .insert_header("Location", location)
      .map_err(|e| middleware_internal_error("redirect insert location failed", e.to_string()))?;
    resp.insert_header("Content-Length", "0").map_err(|e| {
      middleware_internal_error("redirect insert content-length failed", e.to_string())
    })?;

    session
      .write_response_header(Box::new(resp), true)
      .await
      .map_err(|e| middleware_internal_error("redirect write response failed", e.to_string()))?;

    Ok(true)
  }
}
