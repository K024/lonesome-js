use pingora::cache::{
  key::HashBinary, CacheKey, CacheMeta, ForcedFreshness, HitHandler, NoCacheReason,
  RespCacheable,
};
use pingora::http::{RequestHeader, ResponseHeader};
use pingora::proxy::Session;
use pingora::{Error, ErrorSource};

use crate::proxy::ctx::ProxyCtx;

#[derive(Clone, Debug, Default)]
pub struct CacheKeyParts {
  pub namespace: String,
  pub primary: String,
  pub user_tag: String,
}

pub trait ProxyCacheHandler: Send + Sync + 'static {
  fn request_cache_filter(&self, _session: &mut Session, _ctx: &ProxyCtx) -> Result<(), String> {
    Ok(())
  }

  fn cache_key_callback(&self, _session: &Session, _ctx: &ProxyCtx) -> Result<CacheKeyParts, String>;

  fn cache_miss(&self, session: &mut Session, _ctx: &ProxyCtx) {
    session.cache.cache_miss();
  }

  fn cache_hit_filter(
    &self,
    _session: &mut Session,
    _meta: &CacheMeta,
    _hit_handler: &mut HitHandler,
    _is_fresh: bool,
    _ctx: &ProxyCtx
  ) -> Result<Option<ForcedFreshness>, String> {
    Ok(None)
  }

  fn response_cache_filter(
    &self,
    _session: &Session,
    _resp: &ResponseHeader,
    _ctx: &ProxyCtx
  ) -> Result<RespCacheable, String> {
    Ok(RespCacheable::Uncacheable(NoCacheReason::Custom("default")))
  }

  fn response_filter(
    &self,
    _session: &Session,
    _resp: &mut ResponseHeader,
    _ctx: &ProxyCtx
  ) -> Result<(), String> {
    Ok(())
  }

  fn cache_vary_filter(
    &self,
    _meta: &CacheMeta,
    _req: &RequestHeader,
    _ctx: &ProxyCtx
  ) -> Option<HashBinary> {
    None
  }

  fn cache_not_modified_filter(
    &self,
    session: &Session,
    resp: &ResponseHeader,
    _ctx: &ProxyCtx
  ) -> Result<bool, String> {
    Ok(pingora::protocols::http::conditional_filter::not_modified_filter(
      session.req_header(),
      resp,
    ))
  }

  fn should_serve_stale(&self, _session: &mut Session, error: Option<&Error>, _ctx: &ProxyCtx) -> bool {
    error.is_some_and(|e| e.esource() == &ErrorSource::Upstream)
  }

  fn is_purge(&self, _session: &Session, _ctx: &ProxyCtx) -> bool {
    false
  }
}

pub fn build_cache_key(parts: CacheKeyParts) -> CacheKey {
  CacheKey::new(parts.namespace, parts.primary, parts.user_tag)
}
