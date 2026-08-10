use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use pingora::cache::{
  key::HashBinary, CacheKey, CacheMeta, ForcedFreshness, HitHandler, NoCacheReason, RespCacheable,
};
use pingora::http::{RequestHeader, ResponseHeader};
use pingora::protocols::Digest;
use pingora::proxy::{FailToProxy, ProxyHttp, Session};
use pingora::upstreams::peer::HttpPeer;
use pingora::{Error, ErrorType, Result};

use crate::config::SniHostPolicy;
use crate::matcher::cel_session_context::ensure_session_cel_context;
use crate::matcher::cel_session_context::hostname_eq;
use crate::middlewares::middleware::middleware_internal_error;
use crate::proxy::cache::{build_cache_key, ProxyCacheHandler};
use crate::proxy::ctx::{ProxyCtx, ResponseBodyOverride};
use crate::proxy::response::write_response;
use crate::route::{Route, SharedRouteTable};
use crate::server::error_page_store::ErrorPageStore;

#[derive(Clone)]
pub struct LonesomeProxy {
  routes: SharedRouteTable,
  sni_host_policy: SniHostPolicy,
  error_pages: Arc<ErrorPageStore>,
  downstream_read_timeout: Option<Duration>,
  downstream_write_timeout: Option<Duration>,
}

impl LonesomeProxy {
  pub fn new(
    routes: SharedRouteTable,
    sni_host_policy: SniHostPolicy,
    error_pages: Arc<ErrorPageStore>,
    downstream_read_timeout: Option<Duration>,
    downstream_write_timeout: Option<Duration>,
  ) -> Self {
    Self {
      routes,
      sni_host_policy,
      error_pages,
      downstream_read_timeout,
      downstream_write_timeout,
    }
  }

  fn ensure_ctx_route(&self, session: &Session, ctx: &mut ProxyCtx) -> bool {
    let snapshot = self.routes.read_snapshot();
    if let Some(route) = snapshot.find_first_match(session, ctx) {
      ctx.set_route(route.clone());
      return true;
    }
    return false;
  }

  fn current_route(ctx: &ProxyCtx) -> Option<Arc<Route>> {
    ctx.route().cloned()
  }

  fn current_cache_handler(ctx: &ProxyCtx) -> Option<Arc<dyn ProxyCacheHandler>> {
    ctx.cache_handler.clone()
  }

  /// Enforces the `sniHostPolicy` gate for strict modes. Returns the HTTP
  /// status to reject with when the request must be refused:
  /// - `400` when `:authority` and `Host` are both present but disagree
  ///   (RFC 9113 §8.3.1 malformed request);
  /// - `421` when the SNI differs from the HTTP authority (both present).
  fn sni_host_reject(&self, session: &Session, ctx: &mut ProxyCtx) -> Option<u16> {
    let cel = ensure_session_cel_context(session, ctx);
    let cel_session = &cel.cel_http_session;
    sni_host_policy_reject(
      self.sni_host_policy,
      cel_session.sni(),
      cel_session.http_authority().as_deref(),
      cel_session.authority_conflict(),
    )
  }
}

#[async_trait]
impl ProxyHttp for LonesomeProxy {
  type CTX = ProxyCtx;

  fn new_ctx(&self) -> Self::CTX {
    ProxyCtx::new(self.sni_host_policy, self.error_pages.clone())
  }

  async fn early_request_filter(&self, session: &mut Session, ctx: &mut Self::CTX) -> Result<()> {
    ctx.reset_for_request();
    if let Some(timeout) = self.downstream_read_timeout {
      session.as_downstream_mut().set_read_timeout(Some(timeout));
    }
    if let Some(timeout) = self.downstream_write_timeout {
      session.as_downstream_mut().set_write_timeout(Some(timeout));
    }
    let _ = ensure_session_cel_context(session, ctx);
    let _ = self.ensure_ctx_route(session, ctx);

    if let Some(route) = Self::current_route(ctx) {
      for middleware in route.middlewares() {
        middleware.early_request_filter(ctx, session).await?;
      }
    }

    Ok(())
  }

  async fn request_filter(&self, session: &mut Session, ctx: &mut Self::CTX) -> Result<bool> {
    if let Some(status) = self.sni_host_reject(session, ctx) {
      write_response(ctx, session, status, &[], None, None).await?;
      return Ok(true);
    }

    let Some(route) = Self::current_route(ctx) else {
      return Ok(false);
    };

    for middleware in route.middlewares() {
      if middleware.request_filter(ctx, session).await? {
        return Ok(true);
      }
    }

    Ok(false)
  }

  // async fn request_body_filter(
  //   &self,
  //   session: &mut Session,
  //   body: &mut Option<Bytes>,
  //   end_of_stream: bool,
  //   ctx: &mut Self::CTX,
  // ) -> Result<()> {
  //   let Some(route) = Self::current_route(ctx) else {
  //     return Ok(());
  //   };

  //   for middleware in route.middlewares() {
  //     middleware
  //       .request_body_filter(ctx, session, body, end_of_stream)
  //       .await
  //       .map_err(|e| Self::map_middleware_error("middleware request_body_filter failed", e))?;
  //   }

  //   Ok(())
  // }

  async fn proxy_upstream_filter(
    &self,
    session: &mut Session,
    ctx: &mut Self::CTX,
  ) -> Result<bool> {
    let Some(route) = Self::current_route(ctx) else {
      return Ok(true);
    };

    for middleware in route.middlewares() {
      if !middleware.proxy_upstream_filter(ctx, session).await? {
        return Ok(false);
      }
    }

    Ok(true)
  }

  async fn upstream_peer(
    &self,
    _session: &mut Session,
    ctx: &mut Self::CTX,
  ) -> Result<Box<HttpPeer>> {
    let route = Self::current_route(ctx)
      .ok_or_else(|| Error::explain(ErrorType::HTTPStatus(404), "no route matched"))?;

    route.select_upstream_peer(ctx)
  }

  async fn connected_to_upstream(
    &self,
    session: &mut Session,
    reused: bool,
    peer: &HttpPeer,
    #[cfg(unix)] _fd: std::os::unix::io::RawFd,
    #[cfg(windows)] _sock: std::os::windows::io::RawSocket,
    digest: Option<&Digest>,
    ctx: &mut Self::CTX,
  ) -> Result<()> {
    let Some(route) = Self::current_route(ctx) else {
      return Ok(());
    };

    for middleware in route.middlewares() {
      middleware
        .connected_to_upstream(ctx, session, reused, peer, digest)
        .await?;
    }

    Ok(())
  }

  fn fail_to_connect(
    &self,
    session: &mut Session,
    peer: &HttpPeer,
    ctx: &mut Self::CTX,
    e: Box<Error>,
  ) -> Box<Error> {
    let Some(route) = Self::current_route(ctx) else {
      return e;
    };

    let mut err = e;
    for middleware in route.middlewares() {
      let current = err;
      match middleware.fail_to_connect(ctx, session, peer, current) {
        Ok(next) => {
          err = next;
        }
        Err(mw_err) => {
          err =
            middleware_internal_error("middleware fail_to_connect hook error", mw_err.to_string());
        }
      }
    }
    err
  }

  async fn upstream_request_filter(
    &self,
    session: &mut Session,
    upstream_request: &mut RequestHeader,
    ctx: &mut Self::CTX,
  ) -> Result<()> {
    let Some(route) = Self::current_route(ctx) else {
      return Ok(());
    };

    for middleware in route.middlewares() {
      middleware
        .upstream_request_filter(ctx, session, upstream_request)
        .await?;
    }

    // `strict_rewrite_header` forces the authority forwarded to the upstream
    // (both the `Host` header for the HTTP/1.1 hop and the URI authority for
    // the HTTP/2 hop) to the TLS SNI, so an upstream doing vhost routing can
    // never see the mismatched client-supplied value.
    if self.sni_host_policy == SniHostPolicy::StrictRewriteHeader {
      let cel = ensure_session_cel_context(session, ctx);
      if let Some(sni) = cel.cel_http_session.sni() {
        force_authority(upstream_request, sni);
      }
    }

    Ok(())
  }

  async fn upstream_response_filter(
    &self,
    session: &mut Session,
    upstream_response: &mut ResponseHeader,
    ctx: &mut Self::CTX,
  ) -> Result<()> {
    let Some(route) = Self::current_route(ctx) else {
      return Ok(());
    };

    if let Some(cel_session_ctx) = &mut ctx.session_cel_context {
      cel_session_ctx
        .cel_http_session
        .set_upstream_res_header(Some(upstream_response.clone()));
    }

    for middleware in route.middlewares() {
      middleware
        .upstream_response_filter(ctx, session, upstream_response)
        .await?;
    }

    Ok(())
  }

  fn upstream_response_body_filter(
    &self,
    _session: &mut Session,
    body: &mut Option<Bytes>,
    _end_of_stream: bool,
    ctx: &mut Self::CTX,
  ) -> Result<Option<Duration>> {
    // A middleware that takes over the upstream response (e.g.
    // `rewrite_error_page`) records the replacement on the ctx; the swap is
    // applied here in the proxy layer rather than by each middleware, so the
    // override semantics stay centralized.
    if let Some(body_override) = &mut ctx.response_body_override {
      match body_override {
        ResponseBodyOverride::Replace(replacement) => {
          *body = Some(std::mem::take(replacement));
          *body_override = ResponseBodyOverride::DropRemaining;
        }
        ResponseBodyOverride::DropRemaining => {
          *body = None;
        }
      }
    }

    Ok(None)
  }

  async fn response_filter(
    &self,
    session: &mut Session,
    upstream_response: &mut ResponseHeader,
    ctx: &mut Self::CTX,
  ) -> Result<()> {
    if let Some(cache) = Self::current_cache_handler(ctx) {
      cache.response_filter(session, upstream_response, ctx)?;
    }

    let Some(route) = Self::current_route(ctx) else {
      return Ok(());
    };

    for middleware in route.middlewares() {
      middleware
        .response_filter(ctx, session, upstream_response)
        .await?;
    }

    Ok(())
  }

  // fn upstream_response_body_filter(
  //   &self,
  //   session: &mut Session,
  //   body: &mut Option<Bytes>,
  //   end_of_stream: bool,
  //   ctx: &mut Self::CTX,
  // ) -> Result<Option<Duration>> {
  //   let Some(route) = Self::current_route(ctx) else {
  //     return Ok(None);
  //   };

  //   let mut delay = None;
  //   for middleware in route.middlewares() {
  //     let this = middleware
  //       .upstream_response_body_filter(ctx, session, body, end_of_stream)
  //       .map_err(|e| Self::map_middleware_error("middleware upstream_response_body_filter failed", e))?;
  //     if this.is_some() {
  //       delay = this;
  //     }
  //   }

  //   Ok(delay)
  // }

  // fn upstream_response_trailer_filter(
  //   &self,
  //   session: &mut Session,
  //   upstream_trailers: &mut HMap,
  //   ctx: &mut Self::CTX,
  // ) -> Result<()> {
  //   let Some(route) = Self::current_route(ctx) else {
  //     return Ok(());
  //   };

  //   for middleware in route.middlewares() {
  //     middleware
  //       .upstream_response_trailer_filter(ctx, session, upstream_trailers)
  //       .map_err(|e| Self::map_middleware_error("middleware upstream_response_trailer_filter failed", e))?;
  //   }

  //   Ok(())
  // }

  // fn response_body_filter(
  //   &self,
  //   session: &mut Session,
  //   body: &mut Option<Bytes>,
  //   end_of_stream: bool,
  //   ctx: &mut Self::CTX,
  // ) -> Result<Option<Duration>> {
  //   let Some(route) = Self::current_route(ctx) else {
  //     return Ok(None);
  //   };

  //   let mut delay = None;
  //   for middleware in route.middlewares() {
  //     let this = middleware
  //       .response_body_filter(ctx, session, body, end_of_stream)
  //       .map_err(|e| Self::map_middleware_error("middleware response_body_filter failed", e))?;
  //     if this.is_some() {
  //       delay = this;
  //     }
  //   }

  //   Ok(delay)
  // }

  // async fn response_trailer_filter(
  //   &self,
  //   session: &mut Session,
  //   upstream_trailers: &mut HMap,
  //   ctx: &mut Self::CTX,
  // ) -> Result<Option<Bytes>> {
  //   let Some(route) = Self::current_route(ctx) else {
  //     return Ok(None);
  //   };

  //   let mut replacement = None;
  //   for middleware in route.middlewares() {
  //     let this = middleware
  //       .response_trailer_filter(ctx, session, upstream_trailers)
  //       .await
  //       .map_err(|e| Self::map_middleware_error("middleware response_trailer_filter failed", e))?;
  //     if this.is_some() {
  //       replacement = this;
  //     }
  //   }

  //   Ok(replacement)
  // }

  // cache callbacks

  fn request_cache_filter(&self, session: &mut Session, ctx: &mut Self::CTX) -> Result<()> {
    let Some(cache) = Self::current_cache_handler(ctx) else {
      return Ok(());
    };

    cache.request_cache_filter(session, ctx)
  }

  fn cache_key_callback(&self, session: &Session, ctx: &mut Self::CTX) -> Result<CacheKey> {
    let Some(cache) = Self::current_cache_handler(ctx) else {
      return pingora::Error::e_explain(
        ErrorType::InternalError,
        "cache middleware not configured",
      );
    };

    cache.cache_key_callback(session, ctx).map(build_cache_key)
  }

  fn cache_miss(&self, session: &mut Session, ctx: &mut Self::CTX) {
    if let Some(cache) = Self::current_cache_handler(ctx) {
      cache.cache_miss(session, ctx);
    } else {
      session.cache.cache_miss();
    }
  }

  async fn cache_hit_filter(
    &self,
    session: &mut Session,
    meta: &CacheMeta,
    hit_handler: &mut HitHandler,
    is_fresh: bool,
    ctx: &mut Self::CTX,
  ) -> Result<Option<ForcedFreshness>> {
    let Some(cache) = Self::current_cache_handler(ctx) else {
      return Ok(None);
    };

    cache.cache_hit_filter(session, meta, hit_handler, is_fresh, ctx)
  }

  fn response_cache_filter(
    &self,
    session: &Session,
    resp: &ResponseHeader,
    ctx: &mut Self::CTX,
  ) -> Result<RespCacheable> {
    let Some(cache) = Self::current_cache_handler(ctx) else {
      return Ok(RespCacheable::Uncacheable(NoCacheReason::Custom("default")));
    };

    cache.response_cache_filter(session, resp, ctx)
  }

  fn cache_vary_filter(
    &self,
    meta: &CacheMeta,
    ctx: &mut Self::CTX,
    req: &RequestHeader,
  ) -> Option<HashBinary> {
    let cache = Self::current_cache_handler(ctx)?;

    cache.cache_vary_filter(meta, req, ctx)
  }

  fn cache_not_modified_filter(
    &self,
    session: &Session,
    resp: &ResponseHeader,
    ctx: &mut Self::CTX,
  ) -> Result<bool> {
    let Some(cache) = Self::current_cache_handler(ctx) else {
      return Ok(
        pingora::protocols::http::conditional_filter::not_modified_filter(
          session.req_header(),
          resp,
        ),
      );
    };

    cache.cache_not_modified_filter(session, resp, ctx)
  }

  fn should_serve_stale(
    &self,
    session: &mut Session,
    ctx: &mut Self::CTX,
    error: Option<&Error>,
  ) -> bool {
    if let Some(cache) = Self::current_cache_handler(ctx) {
      return cache.should_serve_stale(session, error, ctx);
    }

    error.is_some_and(|e| e.esource() == &pingora::ErrorSource::Upstream)
  }

  fn is_purge(&self, session: &Session, ctx: &Self::CTX) -> bool {
    if let Some(cache) = Self::current_cache_handler(ctx) {
      return cache.is_purge(session, ctx);
    }

    false
  }

  // error callbacks

  fn error_while_proxy(
    &self,
    peer: &HttpPeer,
    session: &mut Session,
    e: Box<Error>,
    ctx: &mut Self::CTX,
    client_reused: bool,
  ) -> Box<Error> {
    let mut err = e.more_context(format!("Peer: {peer}"));
    err
      .retry
      .decide_reuse(client_reused && !session.as_ref().retry_buffer_truncated());

    if let Some(route) = Self::current_route(ctx) {
      for middleware in route.middlewares() {
        let current = err;
        match middleware.error_while_proxy(ctx, session, peer, current, client_reused) {
          Ok(next) => {
            err = next;
          }
          Err(mw_err) => {
            err = middleware_internal_error(
              "middleware error_while_proxy hook error",
              mw_err.to_string(),
            );
          }
        }
      }
    }

    err
  }

  async fn fail_to_proxy(
    &self,
    session: &mut Session,
    e: &Error,
    ctx: &mut Self::CTX,
  ) -> FailToProxy {
    if let Some(route) = Self::current_route(ctx) {
      for middleware in route.middlewares() {
        match middleware.fail_to_proxy(ctx, session, e).await {
          Ok(Some(v)) => return v,
          Ok(None) => {}
          Err(_) => {}
        }
      }
    }

    let code = match e.etype() {
      ErrorType::HTTPStatus(code) => *code,
      _ => 502,
    };

    if code > 0 {
      let _ = write_response(ctx, session, code, &[], None, None).await;
    }

    FailToProxy {
      error_code: code,
      can_reuse_downstream: false,
    }
  }

  async fn logging(&self, session: &mut Session, e: Option<&Error>, ctx: &mut Self::CTX) {
    if let Some(route) = Self::current_route(ctx) {
      for middleware in route.middlewares() {
        let _ = middleware.logging(ctx, session, e).await;
      }
    }
  }
}

/// The pure decision behind [`LonesomeProxy::sni_host_reject`]: which HTTP
/// status (if any) the `sniHostPolicy` asks to reject the request with.
fn sni_host_policy_reject(
  policy: SniHostPolicy,
  sni: Option<&str>,
  authority: Option<&str>,
  authority_conflict: bool,
) -> Option<u16> {
  match policy {
    SniHostPolicy::Strict => {
      if authority_conflict {
        return Some(400);
      }
      if let (Some(sni), Some(authority)) = (sni, authority) {
        if !hostname_eq(sni, authority) {
          return Some(421);
        }
      }
      None
    }
    // `strict_rewrite_header` never rejects an SNI/Host mismatch (it rewrites
    // the forwarded authority instead), but still rejects the RFC 9113
    // `:authority` vs `Host` protocol conflict.
    SniHostPolicy::StrictRewriteHeader => {
      if authority_conflict {
        return Some(400);
      }
      None
    }
    SniHostPolicy::LooseBySni | SniHostPolicy::LooseByHeader => None,
  }
}

/// Overwrites both authority representations of an upstream request with a
/// single value: the `Host` header (used for the HTTP/1.1 hop) and the URI
/// authority (used for the HTTP/2 hop, which pingora prefers over `Host`).
fn force_authority(req: &mut RequestHeader, authority: &str) {
  if let Ok(value) = http::header::HeaderValue::from_str(authority) {
    req.headers.insert(http::header::HOST, value);
  }

  let uri = http::Uri::builder()
    .scheme(req.uri.scheme_str().unwrap_or("https"))
    .authority(authority)
    .path_and_query(req.uri.path_and_query().map(|p| p.as_str()).unwrap_or("/"))
    .build();
  if let Ok(uri) = uri {
    req.set_uri(uri);
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn reject(
    policy: SniHostPolicy,
    sni: Option<&str>,
    authority: Option<&str>,
    conflict: bool,
  ) -> Option<u16> {
    sni_host_policy_reject(policy, sni, authority, conflict)
  }

  #[test]
  fn loose_policies_never_reject() {
    for policy in [SniHostPolicy::LooseBySni, SniHostPolicy::LooseByHeader] {
      assert_eq!(reject(policy, Some("a.com"), Some("b.com"), true), None);
      assert_eq!(reject(policy, Some("a.com"), Some("b.com"), false), None);
    }
  }

  #[test]
  fn strict_rejects_sni_authority_mismatch_with_421() {
    assert_eq!(
      reject(SniHostPolicy::Strict, Some("a.com"), Some("b.com"), false),
      Some(421)
    );
    // case-insensitive + trailing dot are not a mismatch
    assert_eq!(
      reject(SniHostPolicy::Strict, Some("A.com."), Some("a.com"), false),
      None
    );
  }

  #[test]
  fn strict_rejects_authority_conflict_with_400() {
    assert_eq!(
      reject(SniHostPolicy::Strict, None, Some("b.com"), true),
      Some(400)
    );
    // conflict wins over the SNI comparison
    assert_eq!(
      reject(SniHostPolicy::Strict, Some("a.com"), Some("b.com"), true),
      Some(400)
    );
  }

  #[test]
  fn strict_does_not_reject_when_a_side_is_missing() {
    // no SNI (cleartext or no-SNI TLS): nothing to compare against
    assert_eq!(
      reject(SniHostPolicy::Strict, None, Some("a.com"), false),
      None
    );
    // no HTTP authority (e.g. CONNECT without Host): separate malformed path
    assert_eq!(
      reject(SniHostPolicy::Strict, Some("a.com"), None, false),
      None
    );
  }

  #[test]
  fn strict_rewrite_header_rejects_only_protocol_conflict() {
    // SNI/Host mismatch is rewritten, not rejected
    assert_eq!(
      reject(
        SniHostPolicy::StrictRewriteHeader,
        Some("a.com"),
        Some("b.com"),
        false,
      ),
      None
    );
    // :authority vs Host disagreement is still a malformed request
    assert_eq!(
      reject(
        SniHostPolicy::StrictRewriteHeader,
        Some("a.com"),
        Some("b.com"),
        true
      ),
      Some(400)
    );
  }

  #[test]
  fn force_authority_overwrites_both_representations() {
    let mut req = RequestHeader::build("GET", b"/x", Some(1)).unwrap();
    req.insert_header("host", "old.example").unwrap();
    req.set_uri(
      http::Uri::builder()
        .scheme("https")
        .authority("old.example")
        .path_and_query("/x")
        .build()
        .unwrap(),
    );

    force_authority(&mut req, "new.example");

    assert_eq!(
      req.headers.get("host").and_then(|v| v.to_str().ok()),
      Some("new.example")
    );
    assert_eq!(req.uri.authority().map(|a| a.host()), Some("new.example"));
    assert_eq!(req.uri.path_and_query().map(|p| p.as_str()), Some("/x"));
  }
}
