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
pub struct CorsConfig {
  pub allow_origin: Option<String>,
  pub allow_methods: Option<String>,
  pub allow_headers: Option<String>,
  pub expose_headers: Option<String>,
  pub allow_credentials: Option<bool>,
  pub max_age_secs: Option<u64>,
  pub reflect_host: Option<bool>,
  pub rule: Option<String>,
}

impl CorsConfig {
  pub fn validate(&self) -> Result<(), String> {
    if let Some(origin) = &self.allow_origin {
      if origin.trim().is_empty() {
        return Err("middleware cors.allow_origin cannot be empty".to_string());
      }
    }

    Ok(())
  }
}

pub struct CorsMiddleware {
  allow_origin: String,
  allow_methods: String,
  allow_headers: String,
  expose_headers: Option<String>,
  allow_credentials: bool,
  max_age_secs: Option<u64>,
  reflect_host: bool,
  cel_program: Option<Program>,
}

impl CorsMiddleware {
  pub fn from_config(cfg: CorsConfig) -> Result<Self, String> {
    cfg.validate()?;

    let cel_program = if let Some(expr) = cfg.rule {
      Some(
        Program::compile(&expr)
          .map_err(|e| format!("failed to compile cors rule '{expr}': {e}"))?,
      )
    } else {
      None
    };

    Ok(Self {
      allow_origin: cfg.allow_origin.unwrap_or_else(|| "*".to_string()),
      allow_methods: cfg
        .allow_methods
        .unwrap_or_else(|| "GET,POST,PUT,PATCH,DELETE,OPTIONS".to_string()),
      allow_headers: cfg.allow_headers.unwrap_or_else(|| "*".to_string()),
      expose_headers: cfg.expose_headers,
      allow_credentials: cfg.allow_credentials.unwrap_or(false),
      max_age_secs: cfg.max_age_secs,
      reflect_host: cfg.reflect_host.unwrap_or(false),
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

  fn resolve_allow_origin(&self, session: &Session) -> Option<String> {
    match self.allow_origin.as_str() {
      "*" => {
        if self.reflect_host {
          let req = session.req_header();
          let host = req
            .headers
            .get("host")
            .and_then(|v| v.to_str().ok())
            .or_else(|| req.uri.authority().map(|a| a.as_str()))?;

          return Some(format!("{}://{}", "https", host));
        }
        None
      }
      default => Some(default.to_string()),
    }
  }

  fn apply_headers(&self, session: &Session, resp: &mut ResponseHeader) -> Result<()> {
    let allow_origin = self
      .resolve_allow_origin(session)
      .unwrap_or_else(|| "*".to_string());

    resp
      .insert_header("Access-Control-Allow-Origin", allow_origin.as_str())
      .map_err(|e| middleware_internal_error("cors insert allow-origin failed", e.to_string()))?;
    if self.reflect_host {
      resp
        .append_header("vary", "host")
        .map_err(|e| middleware_internal_error("cors append vary host failed", e.to_string()))?;
    }
    resp
      .insert_header("Access-Control-Allow-Methods", self.allow_methods.as_str())
      .map_err(|e| middleware_internal_error("cors insert allow-methods failed", e.to_string()))?;
    resp
      .insert_header("Access-Control-Allow-Headers", self.allow_headers.as_str())
      .map_err(|e| middleware_internal_error("cors insert allow-headers failed", e.to_string()))?;

    if let Some(expose_headers) = &self.expose_headers {
      resp
        .insert_header("Access-Control-Expose-Headers", expose_headers.as_str())
        .map_err(|e| {
          middleware_internal_error("cors insert expose-headers failed", e.to_string())
        })?;
    }

    if self.allow_credentials {
      resp
        .insert_header("Access-Control-Allow-Credentials", "true")
        .map_err(|e| {
          middleware_internal_error("cors insert allow-credentials failed", e.to_string())
        })?;
    }

    if let Some(max_age_secs) = self.max_age_secs {
      resp
        .insert_header("Access-Control-Max-Age", max_age_secs.to_string())
        .map_err(|e| middleware_internal_error("cors insert max-age failed", e.to_string()))?;
    }

    Ok(())
  }
}

#[async_trait]
impl Middleware for CorsMiddleware {
  async fn request_filter(&self, proxy_ctx: &mut ProxyCtx, session: &mut Session) -> Result<bool> {
    if !self.should_apply(proxy_ctx, session) {
      return Ok(false);
    }

    if session.req_header().method.as_str() != "OPTIONS" {
      return Ok(false);
    }

    let mut resp = ResponseHeader::build(204, Some(8)).map_err(|e| {
      middleware_internal_error("cors create preflight response failed", e.to_string())
    })?;
    self.apply_headers(session, &mut resp)?;
    resp
      .insert_header("Content-Length", "0")
      .map_err(|e| middleware_internal_error("cors insert content-length failed", e.to_string()))?;

    session
      .write_response_header(Box::new(resp), true)
      .await
      .map_err(|e| {
        middleware_internal_error("cors write preflight response failed", e.to_string())
      })?;

    Ok(true)
  }

  async fn response_filter(
    &self,
    proxy_ctx: &mut ProxyCtx,
    session: &mut Session,
    upstream_response: &mut ResponseHeader,
  ) -> Result<()> {
    if !self.should_apply(proxy_ctx, session) {
      return Ok(());
    }

    self.apply_headers(session, upstream_response)
  }
}
