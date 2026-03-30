use async_trait::async_trait;
use cel::{Program, Value};
use pingora::http::ResponseHeader;
use pingora::proxy::Session;
use serde::Deserialize;

use crate::matcher::cel_session_context::ensure_context;
use crate::middlewares::Middleware;
use crate::proxy::ctx::ProxyCtx;

#[derive(Clone, Debug, Deserialize)]
pub struct RedirectHttpsConfig {
  pub code: Option<u16>,
  pub port: Option<u16>,
  pub to_http: Option<bool>,
  pub rule: Option<String>,
}

impl RedirectHttpsConfig {
  pub fn validate(&self) -> Result<(), String> {
    if let Some(code) = self.code {
      if !matches!(code, 301 | 302 | 303 | 307 | 308) {
        return Err(
          "middleware redirect_https.code must be one of 301,302,303,307,308".to_string(),
        );
      }
    }

    Ok(())
  }
}

pub struct RedirectHttpsMiddleware {
  code: u16,
  port: Option<u16>,
  to_http: bool,
  cel_program: Option<Program>,
}

impl RedirectHttpsMiddleware {
  pub fn from_config(cfg: RedirectHttpsConfig) -> Result<Self, String> {
    cfg.validate()?;

    let cel_program = if let Some(expr) = cfg.rule {
      Some(
        Program::compile(&expr)
          .map_err(|e| format!("failed to compile redirect_https rule '{expr}': {e}"))?,
      )
    } else {
      None
    };

    Ok(Self {
      code: cfg.code.unwrap_or(301),
      port: cfg.port,
      to_http: cfg.to_http.unwrap_or(false),
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

  fn redirect_location(&self, session: &Session) -> Option<String> {
    let req = session.req_header();

    let host = req
      .headers
      .get("host")
      .and_then(|v| v.to_str().ok())
      .map(|h| h.split(':').next().unwrap_or(h).to_string())
      .or_else(|| req.uri.authority().map(|a| a.host().to_string()))?;

    let mut location = if self.to_http {
      String::from("http://")
    } else {
      String::from("https://")
    };
    location.push_str(&host);

    if let Some(port) = self.port {
      let target_port = if self.to_http { 80 } else { 443 };
      if port != target_port {
        location.push(':');
        location.push_str(&port.to_string());
      }
    }

    location.push_str(req.uri.path_and_query().map(|v| v.as_str()).unwrap_or("/"));

    Some(location)
  }

  fn request_scheme(&self, session: &Session) -> &'static str {
    if let Some(s) = session.req_header().uri.scheme_str() {
      if s.eq_ignore_ascii_case("https") {
        return "https";
      }
      if s.eq_ignore_ascii_case("http") {
        return "http";
      }
    }

    if session
      .as_downstream()
      .digest()
      .and_then(|d| d.ssl_digest.as_ref())
      .is_some()
    {
      "https"
    } else {
      "http"
    }
  }
}

#[async_trait]
impl Middleware for RedirectHttpsMiddleware {
  async fn request_filter(
    &self,
    proxy_ctx: &mut ProxyCtx,
    session: &mut Session,
  ) -> Result<bool, String> {
    if !self.should_apply(proxy_ctx, session) {
      return Ok(false);
    }

    let scheme = self.request_scheme(session);
    if (!self.to_http && scheme == "https") || (self.to_http && scheme == "http") {
      return Ok(false);
    }

    let Some(location) = self.redirect_location(session) else {
      return Ok(false);
    };

    let mut resp = ResponseHeader::build(self.code, Some(2))
      .map_err(|e| format!("redirect_https create response header failed: {e}"))?;
    resp
      .insert_header("location", location)
      .map_err(|e| format!("redirect_https insert location failed: {e}"))?;
    resp
      .insert_header("content-length", "0")
      .map_err(|e| format!("redirect_https insert content-length failed: {e}"))?;

    session
      .write_response_header(Box::new(resp), true)
      .await
      .map_err(|e| format!("redirect_https write response failed: {e}"))?;

    Ok(true)
  }
}
