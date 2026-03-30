use async_trait::async_trait;
use cel::{Program, Value};
use pingora::proxy::Session;
use serde::Deserialize;

use crate::matcher::cel_session_context::ensure_context;
use crate::middlewares::Middleware;
use crate::proxy::ctx::ProxyCtx;

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum RewriteModeConfig {
  RegexRewrite { find: String, replace: String },
  CelRewrite { expression: String },
}

#[derive(Clone, Debug, Deserialize)]
pub struct RewriteConfig {
  #[serde(flatten)]
  pub mode: RewriteModeConfig,
  pub rule: Option<String>,
}

impl RewriteConfig {
  pub fn validate(&self) -> Result<(), String> {
    match &self.mode {
      RewriteModeConfig::RegexRewrite { find, .. } => {
        if find.is_empty() {
          return Err("middleware rewrite.find cannot be empty".to_string());
        }
      }
      RewriteModeConfig::CelRewrite { expression } => {
        if expression.trim().is_empty() {
          return Err("middleware rewrite.expression cannot be empty".to_string());
        }
      }
    }

    Ok(())
  }
}

enum RewriteMode {
  RegexRewrite {
    regex: regex::Regex,
    replace: String,
  },
  CelRewrite {
    program: Program,
  },
}

pub struct RewriteMiddleware {
  mode: RewriteMode,
  cel_program: Option<Program>,
}

impl RewriteMiddleware {
  pub fn from_config(cfg: RewriteConfig) -> Result<Self, String> {
    cfg.validate()?;

    let mode = match cfg.mode {
      RewriteModeConfig::RegexRewrite { find, replace } => {
        let regex = regex::Regex::new(&find)
          .map_err(|e| format!("middleware rewrite.find is invalid regex: {e}"))?;
        RewriteMode::RegexRewrite { regex, replace }
      }
      RewriteModeConfig::CelRewrite { expression } => {
        let program = Program::compile(&expression)
          .map_err(|e| format!("failed to compile rewrite expression '{expression}': {e}"))?;
        RewriteMode::CelRewrite { program }
      }
    };

    let cel_program = if let Some(expr) = cfg.rule {
      Some(
        Program::compile(&expr)
          .map_err(|e| format!("failed to compile rewrite rule '{expr}': {e}"))?,
      )
    } else {
      None
    };

    Ok(Self { mode, cel_program })
  }

  fn should_apply(&self, proxy_ctx: &mut ProxyCtx, session: &Session) -> bool {
    let Some(program) = &self.cel_program else {
      return true;
    };

    let ctx = ensure_context(session, proxy_ctx);
    matches!(program.execute(ctx), Ok(Value::Bool(true)))
  }

  fn rewrite_path(
    &self,
    path_and_query: &str,
    proxy_ctx: &mut ProxyCtx,
    session: &Session,
  ) -> Option<String> {
    match &self.mode {
      RewriteMode::RegexRewrite { regex, replace } => {
        if !regex.is_match(path_and_query) {
          return None;
        }
        Some(regex.replace(path_and_query, replace.as_str()).into_owned())
      }
      RewriteMode::CelRewrite { program } => {
        let ctx = ensure_context(session, proxy_ctx);
        match program.execute(ctx) {
          Ok(Value::String(v)) => Some(v.to_string()),
          _ => None,
        }
      }
    }
  }
}

#[async_trait]
impl Middleware for RewriteMiddleware {
  async fn request_filter(
    &self,
    proxy_ctx: &mut ProxyCtx,
    session: &mut Session,
  ) -> Result<bool, String> {
    if !self.should_apply(proxy_ctx, session) {
      return Ok(false);
    }

    let current = session
      .req_header()
      .uri
      .path_and_query()
      .map(|v| v.as_str())
      .unwrap_or("/")
      .to_string();

    let Some(new_path) = self.rewrite_path(&current, proxy_ctx, session) else {
      return Ok(false);
    };

    let path = if new_path.starts_with('/') {
      new_path
    } else {
      format!("/{new_path}")
    };

    let old_uri = session.req_header().uri.clone();

    let mut builder = http::Uri::builder();
    if let Some(scheme) = old_uri.scheme() {
      builder = builder.scheme(scheme.as_str());
    }
    if let Some(authority) = old_uri.authority() {
      builder = builder.authority(authority.as_str());
    }

    let uri = builder
      .path_and_query(path)
      .build()
      .map_err(|e| format!("rewrite builds invalid uri: {e}"))?;

    session.as_downstream_mut().req_header_mut().set_uri(uri);
    Ok(false)
  }
}
