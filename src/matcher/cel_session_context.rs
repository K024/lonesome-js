use std::str::FromStr;
use std::sync::{Arc, OnceLock, RwLock};

use cel::objects::{Opaque, OpaqueEq};
use cel::{Context, Value};
use chrono::{DateTime, FixedOffset};
use josekit::jwt::JwtPayload;
use percent_encoding;
use pingora::http::{RequestHeader, ResponseHeader};
use pingora::protocols::l4::socket::SocketAddr;
use pingora::proxy::Session;
use serde_json::Value as JsonValue;

use crate::config::SniHostPolicy;
use crate::proxy::ctx::ProxyCtx;
use crate::server::tls_callbacks::DownstreamTlsInfo;

use super::cel_common::parent_context;
use super::precheck::Source;

const CEL_HTTP_SESSION_KEY: &str = "_cel_http_session";

/// Compares two hostnames as the DNS/TLS host comparison does: ASCII
/// case-insensitive with any trailing dot ignored. Ports are not expected.
pub fn hostname_eq(a: &str, b: &str) -> bool {
  a.trim_end_matches('.')
    .eq_ignore_ascii_case(b.trim_end_matches('.'))
}

#[derive(Debug)]
pub struct CelHttpSession {
  req_header: RequestHeader,
  upstream_res_header: RwLock<Option<ResponseHeader>>,
  jwt_payload: RwLock<Option<JwtPayload>>,
  client_addr: Option<SocketAddr>,
  tls_sni: Option<String>,
  sni_host_policy: SniHostPolicy,
  request_time: DateTime<FixedOffset>,
  host: OnceLock<String>,
  path: OnceLock<String>,
  client_ip: OnceLock<String>,
  query_pairs: OnceLock<Vec<(String, String)>>,
  /// Set transiently while an error page matcher/body expression is evaluated,
  /// so `ErrorStatusValue()` can report the generated status.
  error_status: RwLock<Option<u16>>,
  /// W3C Trace Context compliant 32-hex trace id: the inbound `traceparent`
  /// trace id when valid, otherwise a freshly generated one.
  trace_id: OnceLock<String>,
}

impl Opaque for CelHttpSession {
  fn runtime_type_name(&self) -> &str {
    "CelHttpSession"
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
  pub fn from_session(session: &Session, sni_host_policy: SniHostPolicy) -> Self {
    let tls_sni = session
      .as_downstream()
      .digest()
      .and_then(|d| d.ssl_digest.as_ref())
      .and_then(|d| d.extension.get::<DownstreamTlsInfo>())
      .and_then(|info| info.sni.clone());

    Self {
      // TODO: borrow req_header when cel-rust supports it
      req_header: session.req_header().clone(),
      upstream_res_header: RwLock::new(None),
      jwt_payload: RwLock::new(None),
      client_addr: session.as_downstream().client_addr().cloned(),
      tls_sni,
      sni_host_policy,
      request_time: chrono::Utc::now().fixed_offset(),
      host: OnceLock::new(),
      path: OnceLock::new(),
      client_ip: OnceLock::new(),
      query_pairs: OnceLock::new(),
      error_status: RwLock::new(None),
      trace_id: OnceLock::new(),
    }
  }

  pub fn set_upstream_res_header(&self, header: Option<ResponseHeader>) {
    if let Ok(mut lock) = self.upstream_res_header.write() {
      *lock = header;
    }
  }

  pub fn req_header(&self) -> &RequestHeader {
    &self.req_header
  }

  pub fn set_jwt_payload(&self, payload: Option<JwtPayload>) {
    if let Ok(mut lock) = self.jwt_payload.write() {
      *lock = payload;
    }
  }

  pub fn jwt_payload_string(&self) -> Option<String> {
    self
      .jwt_payload
      .read()
      .ok()
      .and_then(|lock| lock.as_ref().map(|p| p.to_string()))
  }

  pub fn jwt_claim_value(&self, key: &str) -> Option<JsonValue> {
    self
      .jwt_payload
      .read()
      .ok()
      .and_then(|lock| lock.as_ref().and_then(|p| p.claim(key).cloned()))
  }

  pub fn client_addr(&self) -> Option<&SocketAddr> {
    self.client_addr.as_ref()
  }

  /// The TLS SNI offered during the handshake, when present (and non-empty).
  /// `None` for cleartext listeners and clients that do not send SNI.
  pub fn sni(&self) -> Option<&str> {
    self.tls_sni.as_deref().filter(|s| !s.is_empty())
  }

  /// The HTTP-level authority: the `:authority` (URI authority) when present,
  /// otherwise the `Host` header, each with the port stripped. `None` when
  /// neither exists (e.g. a malformed request).
  pub fn http_authority(&self) -> Option<String> {
    self.authority_sources().0.or(self.authority_sources().1)
  }

  /// True when the request carries both an `:authority` and a `Host` header
  /// that identify different entities. Per RFC 9113 §8.3.1 this is a malformed
  /// request; when both are present the `:authority` must be used to determine
  /// the target.
  pub fn authority_conflict(&self) -> bool {
    let (authority, host_header) = self.authority_sources();
    match (authority, host_header) {
      (Some(a), Some(h)) => !hostname_eq(&a, &h),
      _ => false,
    }
  }

  fn authority_sources(&self) -> (Option<String>, Option<String>) {
    let authority = self
      .req_header
      .uri
      .authority()
      .map(|a| a.host().to_string());
    let host_header = self
      .req_header
      .headers
      .get("host")
      .and_then(|v| v.to_str().ok())
      .map(|h| h.split(':').next().unwrap_or(h).trim().to_string());
    (authority, host_header)
  }

  pub fn host(&self) -> &str {
    self.host.get_or_init(|| {
      let authority = self.http_authority();
      match self.sni_host_policy {
        SniHostPolicy::LooseBySni | SniHostPolicy::StrictRewriteHeader => self
          .sni()
          .map(ToOwned::to_owned)
          .or(authority)
          .unwrap_or_default(),
        SniHostPolicy::LooseByHeader | SniHostPolicy::Strict => authority.unwrap_or_default(),
      }
    })
  }

  pub fn path(&self) -> &str {
    self
      .path
      .get_or_init(|| decode_path(self.req_header.uri.path()))
  }

  pub fn method(&self) -> &str {
    self.req_header.method.as_str()
  }

  pub fn client_ip(&self) -> &str {
    self.client_ip.get_or_init(|| {
      self
        .client_addr
        .as_ref()
        .and_then(|addr| addr.as_inet())
        .map(|addr| addr.ip().to_string())
        .unwrap_or_default()
    })
  }

  pub fn query_pairs(&self) -> &[(String, String)] {
    self.query_pairs.get_or_init(|| {
      form_urlencoded::parse(self.req_header.uri.query().unwrap_or_default().as_bytes())
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect()
    })
  }

  pub fn request_time(&self) -> DateTime<FixedOffset> {
    self.request_time.to_owned()
  }

  /// Set transiently while an error page matcher/body expression is evaluated.
  pub fn set_error_status(&self, status: Option<u16>) {
    if let Ok(mut lock) = self.error_status.write() {
      *lock = status;
    }
  }

  /// The generated error status currently being served (for `ErrorStatusValue`).
  pub fn error_status(&self) -> Option<u16> {
    self.error_status.read().ok().and_then(|lock| *lock)
  }

  /// A W3C Trace Context compliant 32-hex trace id, randomly generated once per
  /// request and cached for stability. It does not read any request/session
  /// data and is not propagated by the proxy; using it (set_variable, headers,
  /// logs, ...) is entirely up to the caller. External trace ids can be
  /// handled by the user via `HeaderValue(...)`.
  pub fn trace_id(&self) -> &str {
    self.trace_id.get_or_init(generate_trace_id)
  }

  // response values

  pub fn response_status_value(&self) -> i64 {
    self
      .upstream_res_header
      .read()
      .ok()
      .and_then(|lock| lock.as_ref().map(|h| i64::from(h.status.as_u16())))
      .unwrap_or(0)
  }

  pub fn response_header_value(&self, key: &str) -> String {
    self
      .upstream_res_header
      .read()
      .ok()
      .and_then(|lock| {
        lock
          .as_ref()
          .and_then(|h| h.headers.get(key))
          .and_then(|v| v.to_str().ok())
          .map(|v| v.to_string())
      })
      .unwrap_or_default()
  }

  /// Builds a synthetic session from minimal request inputs for offline rule
  /// evaluation. Everything else takes its default: no TLS SNI, no client
  /// address (empty `ClientIP`), no JWT payload, no upstream response header,
  /// `RequestTime` = now. `path` is the origin-form request target, including
  /// query (`/api?x=1`); the host comes from a `host` header when provided.
  pub(crate) fn with_request(
    method: &str,
    path: &str,
    headers: Option<&[(String, String)]>,
  ) -> Result<Self, String> {
    let size_hint = headers.map_or(0, |hs| hs.len());
    let mut req_header = RequestHeader::build(method, path.as_bytes(), Some(size_hint))
      .map_err(|e| format!("invalid request: {e}"))?;
    if let Some(headers) = headers {
      for (name, value) in headers {
        let name = http::header::HeaderName::from_str(name)
          .map_err(|e| format!("invalid header name: {e}"))?;
        let value = http::header::HeaderValue::from_str(value)
          .map_err(|e| format!("invalid header value for '{name}': {e}"))?;
        req_header.headers.append(name, value);
      }
    }
    Ok(Self {
      req_header,
      upstream_res_header: RwLock::new(None),
      jwt_payload: RwLock::new(None),
      client_addr: None,
      tls_sni: None,
      sni_host_policy: SniHostPolicy::default(),
      request_time: chrono::Utc::now().fixed_offset(),
      host: OnceLock::new(),
      path: OnceLock::new(),
      client_ip: OnceLock::new(),
      query_pairs: OnceLock::new(),
      error_status: RwLock::new(None),
      trace_id: OnceLock::new(),
    })
  }
}

impl Source for CelHttpSession {
  fn host(&self) -> &str {
    // Inherent `CelHttpSession::host` wins over the trait method, so this is
    // not recursive; values are cached in `OnceLock` and computed exactly the
    // same way as inside CEL function calls.
    self.host()
  }

  fn path(&self) -> &str {
    self.path()
  }
}

pub struct SessionCelContext {
  pub cel_ctx: Box<Context<'static>>,
  pub cel_http_session: Arc<CelHttpSession>,
}

fn read_session_cel_context(
  session: &Session,
  sni_host_policy: SniHostPolicy,
) -> SessionCelContext {
  let cel_session = Arc::new(CelHttpSession::from_session(session, sni_host_policy));

  let mut cel_ctx = parent_context().new_inner_scope();
  cel_ctx.add_variable_from_value(
    CEL_HTTP_SESSION_KEY,
    Value::Opaque(cel_session.clone() as Arc<dyn Opaque>),
  );

  SessionCelContext {
    cel_http_session: cel_session,
    cel_ctx: Box::new(cel_ctx),
  }
}

fn decode_path(path: &str) -> String {
  percent_encoding::percent_decode_str(path)
    .decode_utf8_lossy()
    .into_owned()
}

/// Generates a random W3C-compliant trace id (32 lowercase hex, non-zero).
fn generate_trace_id() -> String {
  loop {
    let bytes: [u8; 16] = rand::random();
    if bytes.iter().any(|b| *b != 0) {
      return hex_encode_lower(&bytes);
    }
  }
}

fn hex_encode_lower(bytes: &[u8]) -> String {
  const HEX: &[u8; 16] = b"0123456789abcdef";
  let mut out = String::with_capacity(bytes.len() * 2);
  for byte in bytes {
    out.push(HEX[(byte >> 4) as usize] as char);
    out.push(HEX[(byte & 0x0f) as usize] as char);
  }
  out
}

pub fn cel_http_session_key() -> &'static str {
  CEL_HTTP_SESSION_KEY
}

pub fn ensure_session_cel_context<'a>(
  session: &Session,
  proxy_ctx: &'a mut ProxyCtx,
) -> &'a SessionCelContext {
  if proxy_ctx.session_cel_context.is_none() {
    let policy = proxy_ctx.sni_host_policy;
    proxy_ctx.session_cel_context = Some(read_session_cel_context(session, policy));
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

pub fn ensure_context_mut<'a>(
  session: &Session,
  proxy_ctx: &'a mut ProxyCtx,
) -> &'a mut Context<'static> {
  if proxy_ctx.session_cel_context.is_none() {
    let policy = proxy_ctx.sni_host_policy;
    proxy_ctx.session_cel_context = Some(read_session_cel_context(session, policy));
  }

  proxy_ctx
    .session_cel_context
    .as_mut()
    .expect("session cel context initialized")
    .cel_ctx
    .as_mut()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::config::SniHostPolicy;

  fn test_session(
    tls_sni: Option<&str>,
    host_header: Option<&str>,
    authority: Option<&str>,
    policy: SniHostPolicy,
  ) -> CelHttpSession {
    let mut req_header = RequestHeader::build("GET", b"/", Some(1)).unwrap();
    if let Some(host) = host_header {
      req_header.insert_header("host", host).unwrap();
    }
    if let Some(authority) = authority {
      let uri = http::Uri::builder()
        .scheme("https")
        .authority(authority)
        .path_and_query("/")
        .build()
        .unwrap();
      req_header.set_uri(uri);
    }
    CelHttpSession {
      req_header,
      upstream_res_header: RwLock::new(None),
      jwt_payload: RwLock::new(None),
      client_addr: None,
      tls_sni: tls_sni.map(ToOwned::to_owned),
      sni_host_policy: policy,
      request_time: chrono::Utc::now().fixed_offset(),
      host: OnceLock::new(),
      path: OnceLock::new(),
      client_ip: OnceLock::new(),
      query_pairs: OnceLock::new(),
      error_status: RwLock::new(None),
      trace_id: OnceLock::new(),
    }
  }

  #[test]
  fn hostname_eq_is_case_insensitive_and_ignores_trailing_dot() {
    assert!(hostname_eq("Example.com", "example.com"));
    assert!(hostname_eq("a.example.com.", "A.EXAMPLE.com"));
    assert!(!hostname_eq("a.example.com", "example.com"));
    assert!(!hostname_eq("example.com", "example.org"));
  }

  #[test]
  fn host_priority_follows_policy() {
    // SNI and Host header disagree; the policy decides what routing sees.
    let policies = [
      (SniHostPolicy::LooseBySni, "sni.example"),
      (SniHostPolicy::StrictRewriteHeader, "sni.example"),
      (SniHostPolicy::LooseByHeader, "host.example"),
      (SniHostPolicy::Strict, "host.example"),
    ];
    for (policy, expected) in policies {
      let s = test_session(Some("sni.example"), Some("host.example"), None, policy);
      assert_eq!(s.host(), expected, "policy {policy:?}");
    }
  }

  #[test]
  fn host_falls_back_to_authority_without_sni() {
    for policy in [
      SniHostPolicy::LooseBySni,
      SniHostPolicy::LooseByHeader,
      SniHostPolicy::Strict,
      SniHostPolicy::StrictRewriteHeader,
    ] {
      let s = test_session(None, Some("fallback.example"), None, policy);
      assert_eq!(s.host(), "fallback.example", "policy {policy:?}");
    }
  }

  #[test]
  fn empty_sni_is_treated_as_absent() {
    let s = test_session(
      Some(""),
      Some("host.example"),
      None,
      SniHostPolicy::LooseBySni,
    );
    assert_eq!(s.host(), "host.example");
    assert_eq!(s.sni(), None);
  }

  #[test]
  fn http_authority_prefers_authority_over_host_header() {
    let s = test_session(
      None,
      Some("host.example:8443"),
      Some("authority.example:443"),
      SniHostPolicy::LooseByHeader,
    );
    assert_eq!(s.http_authority().as_deref(), Some("authority.example"));
    assert!(s.authority_conflict());
  }

  #[test]
  fn authority_conflict_detects_disagreement_only() {
    let conflicting = test_session(
      None,
      Some("a.example"),
      Some("b.example"),
      SniHostPolicy::Strict,
    );
    assert!(conflicting.authority_conflict());

    let agreeing = test_session(
      None,
      Some("a.example:8080"),
      Some("A.example"),
      SniHostPolicy::Strict,
    );
    assert!(!agreeing.authority_conflict());
    // `:authority` wins and keeps its raw casing; comparison is normalized.
    assert_eq!(agreeing.http_authority().as_deref(), Some("A.example"));

    let host_only = test_session(None, Some("a.example"), None, SniHostPolicy::Strict);
    assert!(!host_only.authority_conflict());
    assert_eq!(host_only.http_authority().as_deref(), Some("a.example"));
  }

  #[test]
  fn host_strips_port_from_host_header() {
    let s = test_session(None, Some("example.com:8080"), None, SniHostPolicy::Strict);
    assert_eq!(s.host(), "example.com");
  }
}
