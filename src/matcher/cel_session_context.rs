use std::sync::Arc;

use cel::objects::{Opaque, OpaqueEq};
use cel::{Context, Value};
use percent_encoding;
use pingora::http::RequestHeader;
use pingora::protocols::l4::socket::SocketAddr;
use pingora::proxy::Session;

use crate::proxy::ctx::ProxyCtx;
use crate::server::tls_callbacks::DownstreamTlsInfo;

use super::cel_common::parent_context;

const CEL_HTTP_SESSION_KEY: &str = "_cel_http_session";

#[derive(Clone, Debug)]
pub struct CelHttpSession {
  req_header: RequestHeader,
  client_addr: Option<SocketAddr>,
  tls_sni: Option<String>,
}

impl Opaque for CelHttpSession {
  fn runtime_type_name(&self) -> &str {
    "denali.CelHttpSession"
  }
}

impl OpaqueEq for CelHttpSession {
  fn opaque_eq(&self, other: &dyn Opaque) -> bool {
    other
      .downcast_ref::<CelHttpSession>()
      .map(|rhs| std::ptr::eq(self, rhs))
      .unwrap_or(false)
  }
}

impl CelHttpSession {
  pub fn from_session(session: &Session) -> Self {
    let tls_sni = session
      .as_downstream()
      .digest()
      .and_then(|d| d.ssl_digest.as_ref())
      .and_then(|d| d.extension.get::<DownstreamTlsInfo>())
      .and_then(|info| info.sni.clone());

    Self {
      req_header: session.req_header().clone(),
      client_addr: session.as_downstream().client_addr().cloned(),
      tls_sni,
    }
  }

  pub fn req_header(&self) -> &RequestHeader {
    &self.req_header
  }

  pub fn client_addr(&self) -> Option<&SocketAddr> {
    self.client_addr.as_ref()
  }

  pub fn host(&self) -> String {
    if let Some(sni) = &self.tls_sni {
      if !sni.is_empty() {
        return sni.clone();
      }
    }

    self
      .req_header
      .headers
      .get("host")
      .and_then(|v| v.to_str().ok())
      .map(|h| h.split(':').next().unwrap_or(h).to_string())
      .or_else(|| {
        self
          .req_header
          .uri
          .authority()
          .map(|a| a.host().to_string())
      })
      .unwrap_or_default()
  }

  pub fn path(&self) -> String {
    decode_path(self.req_header.uri.path())
  }

  pub fn method(&self) -> String {
    self.req_header.method.as_str().to_string()
  }

  pub fn client_ip(&self) -> String {
    self
      .client_addr
      .as_ref()
      .and_then(|addr| addr.as_inet())
      .map(|addr| addr.ip().to_string())
      .unwrap_or_default()
  }
}

pub struct SessionCelContext {
  pub cel_ctx: Box<Context<'static>>,
}

fn read_session_cel_context(session: &Session) -> SessionCelContext {
  let cel_session = Arc::new(CelHttpSession::from_session(session));

  let mut cel_ctx = parent_context().new_inner_scope();
  cel_ctx.add_variable_from_value(
    CEL_HTTP_SESSION_KEY,
    Value::Opaque(cel_session as Arc<dyn Opaque>),
  );

  SessionCelContext {
    cel_ctx: Box::new(cel_ctx),
  }
}

fn decode_path(path: &str) -> String {
  percent_encoding::percent_decode_str(path)
    .decode_utf8_lossy()
    .into_owned()
}

pub fn cel_http_session_key() -> &'static str {
  CEL_HTTP_SESSION_KEY
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
