use bytes::Bytes;
use cel::Value;
use pingora::http::ResponseHeader;
use pingora::proxy::Session;
use pingora::Result;

use crate::matcher::cel_session_context::{ensure_context, ensure_session_cel_context};
use crate::middlewares::middleware::middleware_internal_error;
use crate::proxy::ctx::ProxyCtx;
use crate::server::error_page_store::ErrorPageEntry;

/// Write a proxy- or middleware-generated response to the downstream.
///
/// - Caller-provided explicit content (`body` + `content_type`) is written
///   verbatim and never touched by the error page store.
/// - Error statuses (`>= 400`) without explicit content consult the error page
///   store first: the first entry whose status applies and whose matcher (if
///   any) matches renders the page (status override, headers, content type,
///   body from `body` or `body_expression`).
/// - Anything else falls back to a bare response with the given headers.
pub async fn write_response(
  proxy_ctx: &mut ProxyCtx,
  session: &mut Session,
  status: u16,
  headers: &[(&'static str, String)],
  explicit_body: Option<&[u8]>,
  content_type: Option<&str>,
) -> Result<()> {
  // Generated error responses announce `Connection: close`, mirroring pingora's
  // `write_error_response`: these paths (fail_to_proxy, the SNI/Host gate,
  // rate_limit, ...) do not reuse the downstream connection, so keeping it
  // alive would let a client pipeline a request into a socket the server is
  // about to drop.
  if status >= 400 {
    session.as_downstream_mut().set_keepalive(None);
  }

  let (body, effective_status, page_headers, effective_content_type) =
    if let Some(body) = explicit_body {
      (
        Bytes::copy_from_slice(body),
        status,
        Vec::new(),
        content_type.map(ToOwned::to_owned),
      )
    } else if status >= 400 {
      if let Some(page) = lookup_error_page(proxy_ctx, session, status) {
        let body = render_error_page_body(proxy_ctx, session, &page);
        let ct = page
          .content_type
          .clone()
          .unwrap_or_else(|| "text/html; charset=utf-8".to_string());
        (
          body,
          page.status_override.unwrap_or(status),
          page.headers.clone(),
          Some(ct),
        )
      } else {
        (
          Bytes::new(),
          status,
          Vec::new(),
          content_type.map(ToOwned::to_owned),
        )
      }
    } else {
      (
        Bytes::new(),
        status,
        Vec::new(),
        content_type.map(ToOwned::to_owned),
      )
    };

  let mut resp = ResponseHeader::build(effective_status, Some(8))
    .map_err(|e| middleware_internal_error("build generated response failed", e.to_string()))?;

  for (name, value) in &page_headers {
    resp
      .insert_header(name.clone(), value.clone())
      .map_err(|e| middleware_internal_error("insert error page header failed", e.to_string()))?;
  }
  for (name, value) in headers {
    resp
      .insert_header(*name, value.clone())
      .map_err(|e| middleware_internal_error("insert response header failed", e.to_string()))?;
  }

  if !body.is_empty() {
    resp
      .insert_header(
        "Content-Type",
        effective_content_type
          .as_deref()
          .unwrap_or("text/plain; charset=utf-8"),
      )
      .map_err(|e| middleware_internal_error("insert content-type failed", e.to_string()))?;
  }
  resp
    .insert_header("Content-Length", body.len().to_string())
    .map_err(|e| middleware_internal_error("insert content-length failed", e.to_string()))?;

  session
    .write_response_header(Box::new(resp), body.is_empty())
    .await
    .map_err(|e| middleware_internal_error("write generated response failed", e.to_string()))?;

  if !body.is_empty() {
    session
      .write_response_body(Some(body), true)
      .await
      .map_err(|e| {
        middleware_internal_error("write generated response body failed", e.to_string())
      })?;
  }

  Ok(())
}

/// Find the first error page entry that serves `status` and whose matcher (if
/// any) evaluates to true. Sets the transient error status on the session so
/// `ErrorStatusValue()` is available to both matchers and body expressions.
fn lookup_error_page(
  proxy_ctx: &mut ProxyCtx,
  session: &Session,
  status: u16,
) -> Option<std::sync::Arc<ErrorPageEntry>> {
  {
    let cel = ensure_session_cel_context(session, proxy_ctx);
    cel.cel_http_session.set_error_status(Some(status));
  }

  for entry in proxy_ctx.error_pages.snapshot() {
    if !entry.statuses.is_empty() && !entry.statuses.contains(&status) {
      continue;
    }
    if let Some(matcher) = &entry.matcher {
      let ctx = ensure_context(session, proxy_ctx);
      if !matches!(matcher.execute(ctx), Ok(Value::Bool(true))) {
        continue;
      }
    }
    return Some(entry);
  }
  None
}

/// Render the page body: static `body`, or a scalar CEL `body_expression`.
/// Evaluation errors fall back to an empty body so the error path never breaks.
fn render_error_page_body(
  proxy_ctx: &mut ProxyCtx,
  session: &Session,
  page: &ErrorPageEntry,
) -> Bytes {
  if let Some(program) = &page.body_program {
    let ctx = ensure_context(session, proxy_ctx);
    return match program.execute(ctx) {
      Ok(Value::String(v)) => Bytes::from(v.to_string()),
      Ok(Value::Int(v)) => Bytes::from(v.to_string()),
      Ok(Value::UInt(v)) => Bytes::from(v.to_string()),
      Ok(Value::Float(v)) => Bytes::from(v.to_string()),
      Ok(Value::Bool(v)) => Bytes::from(v.to_string()),
      _ => Bytes::new(),
    };
  }
  if let Some(body) = &page.body {
    return Bytes::copy_from_slice(body.as_bytes());
  }
  Bytes::new()
}
