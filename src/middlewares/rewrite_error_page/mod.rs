use async_trait::async_trait;
use cel::{Program, Value};
use pingora::http::ResponseHeader;
use pingora::proxy::Session;
use pingora::Result;
use serde::Deserialize;

use crate::matcher::cel_session_context::ensure_context;
use crate::middlewares::middleware::middleware_internal_error;
use crate::middlewares::Middleware;
use crate::proxy::ctx::{ProxyCtx, ResponseBodyOverride};
use crate::proxy::response::resolve_error_page;
use crate::server::error_page_store::parse_status_spec;

/// Accepts a single status code or a spec string like `"400-403,418,500"`.
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum StatusSpecInput {
  Code(u16),
  Ranges(String),
}

impl StatusSpecInput {
  fn to_spec(&self) -> String {
    match self {
      StatusSpecInput::Code(code) => code.to_string(),
      StatusSpecInput::Ranges(spec) => spec.clone(),
    }
  }
}

#[derive(Clone, Debug, Deserialize)]
pub struct RewriteErrorPageConfig {
  /// Which upstream error statuses to intercept. `None` intercepts any upstream
  /// error status (`>= 400`) for which the error page store has a matching page.
  pub status: Option<StatusSpecInput>,
  /// Optional CEL rule; the rewrite applies only when it evaluates to true.
  pub rule: Option<String>,
}

impl RewriteErrorPageConfig {
  pub fn validate(&self) -> Result<(), String> {
    if let Some(status) = &self.status {
      parse_status_spec(&status.to_spec())?;
    }
    Ok(())
  }
}

/// Intercepts upstream responses with an error status (`>= 400`) and, when the
/// error page store has a matching page, replaces the response with that page
/// instead of forwarding the upstream error body.
pub struct RewriteErrorPageMiddleware {
  statuses: Vec<u16>,
  cel_program: Option<Program>,
}

impl RewriteErrorPageMiddleware {
  pub fn from_config(cfg: RewriteErrorPageConfig) -> Result<Self, String> {
    cfg.validate()?;

    let statuses = match cfg.status.as_ref() {
      Some(status) => parse_status_spec(&status.to_spec())?,
      None => Vec::new(), // any upstream error status
    };

    let cel_program = if let Some(expr) = cfg.rule {
      Some(
        Program::compile(&expr)
          .map_err(|e| format!("failed to compile rewrite_error_page rule '{expr}': {e}"))?,
      )
    } else {
      None
    };

    Ok(Self {
      statuses,
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
impl Middleware for RewriteErrorPageMiddleware {
  async fn upstream_response_filter(
    &self,
    proxy_ctx: &mut ProxyCtx,
    session: &mut Session,
    upstream_response: &mut ResponseHeader,
  ) -> Result<()> {
    if !self.should_apply(proxy_ctx, session) {
      return Ok(());
    }

    let status = upstream_response.status.as_u16();
    if status < 400 {
      return Ok(());
    }
    if !self.statuses.is_empty() && !self.statuses.contains(&status) {
      return Ok(());
    }

    // Pingora never invokes the upstream response body filter for a body-less
    // response (it emits an end-of-stream task directly), so the replacement
    // body could never be written. Replacing the header alone would advertise
    // the page's Content-Length while sending zero bytes, corrupting the
    // response. Pass body-less upstream errors through unchanged.
    if upstream_response
      .headers
      .get("content-length")
      .and_then(|v| v.to_str().ok())
      == Some("0")
    {
      return Ok(());
    }

    let Some(page) = resolve_error_page(proxy_ctx, session, status) else {
      return Ok(());
    };

    let body_len = page.body.len();
    // Build a fresh header: mutating the parsed upstream header in place can
    // desync pingora's case-preservation map and panic on write.
    *upstream_response = build_error_page_header(&page, body_len)
      .map_err(|e| middleware_internal_error("rewrite_error_page build response failed", e))?;

    proxy_ctx.response_body_override = Some(ResponseBodyOverride::Replace(page.body));
    Ok(())
  }
}

/// Builds a fresh response header for the rendered error page.
fn build_error_page_header(
  page: &crate::proxy::response::RenderedErrorPage,
  body_len: usize,
) -> Result<ResponseHeader, String> {
  let mut resp = ResponseHeader::build(page.status, Some(4 + page.headers.len()))
    .map_err(|e| format!("build error page header: {e}"))?;

  for (name, value) in &page.headers {
    resp
      .insert_header(name.clone(), value.clone())
      .map_err(|e| format!("invalid error page header: {e}"))?;
  }

  if let Some(content_type) = &page.content_type {
    resp
      .insert_header("content-type", content_type.as_str())
      .map_err(|e| format!("invalid error page content-type: {e}"))?;
  }

  resp
    .insert_header("content-length", body_len.to_string())
    .map_err(|e| format!("invalid content-length: {e}"))?;

  Ok(resp)
}
