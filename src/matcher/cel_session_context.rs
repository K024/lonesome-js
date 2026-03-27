use cel::Context;
use pingora::proxy::Session;
use serde::Serialize;
use form_urlencoded;
use percent_encoding;

use crate::proxy::ctx::ProxyCtx;

use super::cel_common::parent_context;

pub struct SessionCelContext {
  pub cel_ctx: Box<Context<'static>>,
}

#[derive(Serialize)]
struct NameValuePair {
  name: String,
  value: String,
}

fn read_session_cel_context(session: &Session) -> SessionCelContext {
  let req = session.req_header();

  let host = req
    .headers
    .get("host")
    .and_then(|v| v.to_str().ok())
    .map(|h| h.split(':').next().unwrap_or(h).to_string())
    .unwrap_or_default();

  let path = decode_path(req.uri.path());
  let method = req.method.as_str().to_string();
  let query_raw = req.uri.query().unwrap_or_default().to_string();

  let headers = req
    .headers
    .iter()
    .map(|(name, value)| NameValuePair {
      name: name.as_str().to_ascii_lowercase(),
      value: value.to_str().unwrap_or_default().to_string(),
    })
    .collect::<Vec<_>>();

  let query = parse_query_pairs(query_raw.as_str());

  // TODO: wire real client ip when we have a stable accessor from pingora session.
  let client_ip = String::new();

  let mut cel_ctx = parent_context().new_inner_scope();
  cel_ctx.add_variable_from_value("host", host);
  cel_ctx.add_variable_from_value("path", path);
  cel_ctx.add_variable_from_value("method", method);
  cel_ctx.add_variable_from_value("clientIP", client_ip);
  cel_ctx
    .add_variable("headers", headers)
    .expect("serialize headers for cel context");
  cel_ctx
    .add_variable("query", query)
    .expect("serialize query for cel context");

  SessionCelContext {
    cel_ctx: Box::new(cel_ctx),
  }
}

fn decode_path(path: &str) -> String {
  percent_encoding::percent_decode_str(path)
    .decode_utf8_lossy()
    .into_owned()
}

fn parse_query_pairs(query_raw: &str) -> Vec<NameValuePair> {
  form_urlencoded::parse(query_raw.as_bytes())
    .map(|(k, v)| NameValuePair {
      name: k.into_owned(),
      value: v.into_owned(),
    })
    .collect::<Vec<_>>()
}

pub fn ensure_session_cel_context<'a>(
  session: &Session,
  proxy_ctx: &'a mut ProxyCtx,
) -> &'a SessionCelContext {
  if proxy_ctx.session_cel_context.is_none() {
    proxy_ctx.session_cel_context = Some(read_session_cel_context(session));
  }

  proxy_ctx
    .session_cel_context
    .as_ref()
    .expect("session cel context initialized")
}

pub fn ensure_context<'a>(session: &Session, proxy_ctx: &'a mut ProxyCtx) -> &'a Context<'static> {
  let data = ensure_session_cel_context(session, proxy_ctx);
  data.cel_ctx.as_ref()
}
