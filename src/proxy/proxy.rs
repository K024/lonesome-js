use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use pingora::cache::{
  key::HashBinary, CacheKey, CacheMeta, ForcedFreshness, HitHandler, NoCacheReason,
  RespCacheable,
};
use pingora::http::{HMap, RequestHeader, ResponseHeader};
use pingora::protocols::Digest;
use pingora::proxy::{FailToProxy, ProxyHttp, Session};
use pingora::upstreams::peer::HttpPeer;
use pingora::{Error, ErrorType, Result};

use crate::matcher::cel_session_context::ensure_session_cel_context;
use crate::proxy::cache::{build_cache_key, ProxyCacheHandler};
use crate::proxy::ctx::ProxyCtx;
use crate::route::{Route, SharedRouteTable};

#[derive(Clone)]
pub struct DenaliProxy {
  routes: SharedRouteTable,
}

impl DenaliProxy {
  pub fn new(routes: SharedRouteTable) -> Self {
    Self { routes }
  }

  fn map_middleware_error(phase: &'static str, err: String) -> Box<Error> {
    pingora::Error::because(
      ErrorType::HTTPStatus(500),
      phase,
      std::io::Error::other(err),
    )
  }

  fn map_upstream_error(err: String) -> Box<Error> {
    pingora::Error::because(
      ErrorType::HTTPStatus(502),
      "upstream selection failed",
      std::io::Error::other(err),
    )
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
}

#[async_trait]
impl ProxyHttp for DenaliProxy {
  type CTX = ProxyCtx;

  fn new_ctx(&self) -> Self::CTX {
    ProxyCtx::new()
  }

  async fn early_request_filter(&self, session: &mut Session, ctx: &mut Self::CTX) -> Result<()> {
    ctx.reset_for_request();
    let _ = ensure_session_cel_context(session, ctx);
    let _ = self.ensure_ctx_route(session, ctx);

    if let Some(route) = Self::current_route(ctx) {
      for middleware in route.middlewares() {
        middleware
          .early_request_filter(ctx, session)
          .await
          .map_err(|e| Self::map_middleware_error("middleware early_request_filter failed", e))?;
      }
    }

    Ok(())
  }

  async fn request_filter(&self, session: &mut Session, ctx: &mut Self::CTX) -> Result<bool> {
    let Some(route) = Self::current_route(ctx) else {
      return Ok(false);
    };

    for middleware in route.middlewares() {
      if middleware
        .request_filter(ctx, session)
        .await
        .map_err(|e| Self::map_middleware_error("middleware request_filter failed", e))?
      {
        return Ok(true);
      }
    }

    Ok(false)
  }

  async fn request_body_filter(
    &self,
    session: &mut Session,
    body: &mut Option<Bytes>,
    end_of_stream: bool,
    ctx: &mut Self::CTX,
  ) -> Result<()> {
    let Some(route) = Self::current_route(ctx) else {
      return Ok(());
    };

    for middleware in route.middlewares() {
      middleware
        .request_body_filter(ctx, session, body, end_of_stream)
        .await
        .map_err(|e| Self::map_middleware_error("middleware request_body_filter failed", e))?;
    }

    Ok(())
  }

  async fn proxy_upstream_filter(&self, session: &mut Session, ctx: &mut Self::CTX) -> Result<bool> {
    let Some(route) = Self::current_route(ctx) else {
      return Ok(true);
    };

    for middleware in route.middlewares() {
      if !middleware
        .proxy_upstream_filter(ctx, session)
        .await
        .map_err(|e| Self::map_middleware_error("middleware proxy_upstream_filter failed", e))?
      {
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
    let route = Self::current_route(ctx).ok_or_else(|| {
      pingora::Error::because(
        ErrorType::HTTPStatus(404),
        "no route matched",
        std::io::Error::other("route not found"),
      )
    })?;

    route.select_upstream_peer(ctx).map_err(Self::map_upstream_error)
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
        .await
        .map_err(|e| Self::map_middleware_error("middleware connected_to_upstream failed", e))?;
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
          err = pingora::Error::because(
            ErrorType::InternalError,
            "middleware fail_to_connect hook error",
            std::io::Error::other(mw_err),
          );
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
        .await
        .map_err(|e| Self::map_middleware_error("middleware upstream_request_filter failed", e))?;
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

    for middleware in route.middlewares() {
      middleware
        .upstream_response_filter(ctx, session, upstream_response)
        .await
        .map_err(|e| Self::map_middleware_error("middleware upstream_response_filter failed", e))?;
    }

    Ok(())
  }

  async fn response_filter(
    &self,
    session: &mut Session,
    upstream_response: &mut ResponseHeader,
    ctx: &mut Self::CTX,
  ) -> Result<()> {
    if let Some(cache) = Self::current_cache_handler(ctx) {
      cache
        .response_filter(session, upstream_response)
        .map_err(|e| Self::map_middleware_error("cache response_filter failed", e))?;
    }

    let Some(route) = Self::current_route(ctx) else {
      return Ok(());
    };

    for middleware in route.middlewares() {
      middleware
        .response_filter(ctx, session, upstream_response)
        .await
        .map_err(|e| Self::map_middleware_error("middleware response_filter failed", e))?;
    }

    Ok(())
  }

  fn upstream_response_body_filter(
    &self,
    session: &mut Session,
    body: &mut Option<Bytes>,
    end_of_stream: bool,
    ctx: &mut Self::CTX,
  ) -> Result<Option<Duration>> {
    let Some(route) = Self::current_route(ctx) else {
      return Ok(None);
    };

    let mut delay = None;
    for middleware in route.middlewares() {
      let this = middleware
        .upstream_response_body_filter(ctx, session, body, end_of_stream)
        .map_err(|e| Self::map_middleware_error("middleware upstream_response_body_filter failed", e))?;
      if this.is_some() {
        delay = this;
      }
    }

    Ok(delay)
  }

  fn upstream_response_trailer_filter(
    &self,
    session: &mut Session,
    upstream_trailers: &mut HMap,
    ctx: &mut Self::CTX,
  ) -> Result<()> {
    let Some(route) = Self::current_route(ctx) else {
      return Ok(());
    };

    for middleware in route.middlewares() {
      middleware
        .upstream_response_trailer_filter(ctx, session, upstream_trailers)
        .map_err(|e| Self::map_middleware_error("middleware upstream_response_trailer_filter failed", e))?;
    }

    Ok(())
  }

  fn response_body_filter(
    &self,
    session: &mut Session,
    body: &mut Option<Bytes>,
    end_of_stream: bool,
    ctx: &mut Self::CTX,
  ) -> Result<Option<Duration>> {
    let Some(route) = Self::current_route(ctx) else {
      return Ok(None);
    };

    let mut delay = None;
    for middleware in route.middlewares() {
      let this = middleware
        .response_body_filter(ctx, session, body, end_of_stream)
        .map_err(|e| Self::map_middleware_error("middleware response_body_filter failed", e))?;
      if this.is_some() {
        delay = this;
      }
    }

    Ok(delay)
  }

  async fn response_trailer_filter(
    &self,
    session: &mut Session,
    upstream_trailers: &mut HMap,
    ctx: &mut Self::CTX,
  ) -> Result<Option<Bytes>> {
    let Some(route) = Self::current_route(ctx) else {
      return Ok(None);
    };

    let mut replacement = None;
    for middleware in route.middlewares() {
      let this = middleware
        .response_trailer_filter(ctx, session, upstream_trailers)
        .await
        .map_err(|e| Self::map_middleware_error("middleware response_trailer_filter failed", e))?;
      if this.is_some() {
        replacement = this;
      }
    }

    Ok(replacement)
  }


  // cache callbacks

  fn request_cache_filter(&self, session: &mut Session, ctx: &mut Self::CTX) -> Result<()> {
    let Some(cache) = Self::current_cache_handler(ctx) else {
      return Ok(());
    };

    cache
      .request_cache_filter(session)
      .map_err(|e| Self::map_middleware_error("cache request_cache_filter failed", e))
  }

  fn cache_key_callback(&self, session: &Session, ctx: &mut Self::CTX) -> Result<CacheKey> {
    let Some(cache) = Self::current_cache_handler(ctx) else {
      return Err(pingora::Error::because(
        ErrorType::InternalError,
        "cache middleware not configured",
        std::io::Error::other("cache callbacks missing"),
      ));
    };

    cache
      .cache_key_callback(session)
      .map(build_cache_key)
      .map_err(|e| Self::map_middleware_error("cache cache_key_callback failed", e))
  }

  fn cache_miss(&self, session: &mut Session, ctx: &mut Self::CTX) {
    if let Some(cache) = Self::current_cache_handler(ctx) {
      cache.cache_miss(session);
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

    cache
      .cache_hit_filter(session, meta, hit_handler, is_fresh)
      .map_err(|e| Self::map_middleware_error("cache cache_hit_filter failed", e))
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

    cache
      .response_cache_filter(session, resp)
      .map_err(|e| Self::map_middleware_error("cache response_cache_filter failed", e))
  }

  fn cache_vary_filter(
    &self,
    meta: &CacheMeta,
    ctx: &mut Self::CTX,
    req: &RequestHeader,
  ) -> Option<HashBinary> {
    let Some(cache) = Self::current_cache_handler(ctx) else {
      return None;
    };

    cache.cache_vary_filter(meta, req)
  }

  fn cache_not_modified_filter(
    &self,
    session: &Session,
    resp: &ResponseHeader,
    ctx: &mut Self::CTX,
  ) -> Result<bool> {
    let Some(cache) = Self::current_cache_handler(ctx) else {
      return Ok(pingora::protocols::http::conditional_filter::not_modified_filter(
        session.req_header(),
        resp,
      ));
    };

    cache
      .cache_not_modified_filter(session, resp)
      .map_err(|e| Self::map_middleware_error("cache cache_not_modified_filter failed", e))
  }

  fn should_serve_stale(
    &self,
    session: &mut Session,
    ctx: &mut Self::CTX,
    error: Option<&Error>,
  ) -> bool {
    if let Some(cache) = Self::current_cache_handler(ctx) {
      return cache.should_serve_stale(session, error);
    }

    error.is_some_and(|e| e.esource() == &pingora::ErrorSource::Upstream)
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
            err = pingora::Error::because(
              ErrorType::InternalError,
              "middleware error_while_proxy hook error",
              std::io::Error::other(mw_err),
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
      let _ = session.respond_error(code).await;
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
