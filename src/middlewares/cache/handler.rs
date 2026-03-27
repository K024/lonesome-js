use std::time::Duration;

use std::sync::LazyLock;
use pingora::cache::cache_control::CacheControl;
use pingora::cache::eviction::simple_lru::Manager;
use pingora::cache::lock::{CacheKeyLockImpl, CacheLock};
use pingora::cache::predictor::Predictor;
use pingora::cache::{
  CacheMetaDefaults, CacheOptionOverrides, MemCache, RespCacheable, VarianceBuilder,
  filters::resp_cacheable,
};
use pingora::http::{RequestHeader, ResponseHeader};
use pingora::proxy::Session;

use crate::proxy::cache::{CacheKeyParts, ProxyCacheHandler};

static CACHE_BACKEND: LazyLock<MemCache> = LazyLock::new(MemCache::new);
static CACHE_PREDICTOR: LazyLock<Predictor<32>> = LazyLock::new(|| Predictor::new(5, None));
static CACHE_LOCK: LazyLock<Box<CacheKeyLockImpl>> =
  LazyLock::new(|| CacheLock::new_boxed(Duration::from_secs(2)));
static EVICTION_MANAGER: LazyLock<Manager> = LazyLock::new(|| Manager::new(64 * 1024 * 1024));
static CACHE_DECISION_DEFAULTS: CacheMetaDefaults = CacheMetaDefaults::new(|_| None, 1, 1);

pub(crate) struct CacheHandler {
  max_ttl_secs: u64,
  max_file_size_bytes: Option<usize>,
  inject_cache_headers: bool,
}

impl CacheHandler {
  pub(crate) fn new(
    max_ttl_secs: u64,
    max_file_size_bytes: Option<usize>,
    inject_cache_headers: bool,
  ) -> Self {
    Self {
      max_ttl_secs,
      max_file_size_bytes,
      inject_cache_headers,
    }
  }
}

fn has_vary_star(resp: &ResponseHeader) -> bool {
  for value in resp.headers.get_all("vary") {
    let Ok(raw) = value.to_str() else {
      continue;
    };
    if raw
      .split(',')
      .any(|part| part.trim().eq_ignore_ascii_case("*"))
    {
      return true;
    }
  }
  false
}

impl ProxyCacheHandler for CacheHandler {
  fn request_cache_filter(&self, session: &mut Session) -> Result<(), String> {
    let mut overrides = CacheOptionOverrides::default();
    overrides.wait_timeout = Some(Duration::from_secs(2));

    session.cache.enable(
      &*CACHE_BACKEND,
      Some(&*EVICTION_MANAGER as &'static (dyn pingora::cache::eviction::EvictionManager + Sync)),
      Some(&*CACHE_PREDICTOR as &'static (dyn pingora::cache::predictor::CacheablePredictor + Sync)),
      Some(CACHE_LOCK.as_ref()),
      Some(overrides),
    );

    if let Some(max) = self.max_file_size_bytes {
      session.cache.set_max_file_size_bytes(max);
    }

    Ok(())
  }

  fn response_filter(
    &self,
    session: &Session,
    resp: &mut ResponseHeader,
  ) -> Result<(), String> {
    if !self.inject_cache_headers {
      return Ok(());
    }

    let status = match session.cache.phase() {
      pingora::cache::CachePhase::Hit => "hit",
      pingora::cache::CachePhase::Miss => "miss",
      pingora::cache::CachePhase::Stale => "stale",
      pingora::cache::CachePhase::StaleUpdating => "updating",
      pingora::cache::CachePhase::Expired => "expired",
      pingora::cache::CachePhase::Revalidated => "revalidated",
      pingora::cache::CachePhase::RevalidatedNoCache(_) => "revalidated",
      pingora::cache::CachePhase::Bypass => "bypass",
      pingora::cache::CachePhase::Disabled(_) => "bypass",
      pingora::cache::CachePhase::Uninit => "bypass",
      pingora::cache::CachePhase::CacheKey => "bypass",
    };

    resp
      .insert_header("cdn-cache-status", status)
      .map_err(|e| format!("insert cdn-cache-status failed: {e}"))?;

    Ok(())
  }

  fn cache_key_callback(&self, session: &Session) -> Result<CacheKeyParts, String> {
    let req = session.req_header();

    let host = req.headers
      .get("host")
      .and_then(|v| v.to_str().ok())
      .or_else(|| req.uri.authority().map(|a| a.as_str()))
      .unwrap_or("");

    let path = req.uri
      .path_and_query()
      .map(|pq| pq.as_str())
      .unwrap_or("/");

    Ok(CacheKeyParts {
      namespace: String::new(),
      primary: format!("{host}{path}"),
      user_tag: String::new(),
    })
  }

  fn response_cache_filter(
    &self,
    session: &Session,
    resp: &ResponseHeader,
  ) -> Result<RespCacheable, String> {
    if has_vary_star(resp) {
      return Ok(RespCacheable::Uncacheable(
        pingora::cache::NoCacheReason::OriginNotCache,
      ));
    }

    let cc = CacheControl::from_resp_headers_named("cdn-cache-control", resp)
      .or_else(|| CacheControl::from_resp_headers(resp));

    let has_authorization = session
      .req_header()
      .headers
      .contains_key("authorization");

    let mut cacheable = resp_cacheable(
      cc.as_ref(),
      resp.clone(),
      has_authorization,
      &CACHE_DECISION_DEFAULTS,
    );

    if let RespCacheable::Cacheable(meta) = &mut cacheable {
      let capped_until = meta.created() + Duration::from_secs(self.max_ttl_secs);
      *meta = pingora::cache::CacheMeta::new(
        meta.fresh_until().min(capped_until),
        meta.created(),
        meta.stale_while_revalidate_sec(),
        meta.stale_if_error_sec(),
        meta.response_header().clone(),
      );
    }

    Ok(cacheable)
  }

  fn cache_vary_filter(&self, meta: &pingora::cache::CacheMeta, req: &RequestHeader) -> Option<pingora::cache::key::HashBinary> {
    let mut key = VarianceBuilder::new();

    let vary_headers_lowercased: Vec<String> = meta
      .headers()
      .get_all("vary")
      .iter()
      .flat_map(|vary_header| vary_header.to_str().ok())
      .flat_map(|vary_header| vary_header.split(','))
      .map(|s| s.trim().to_lowercase())
      .collect();

    if vary_headers_lowercased.is_empty() {
      return None;
    }

    vary_headers_lowercased.iter().for_each(|header_name| {
      // Add this header and value to be considered in the variance key.
      key.add_value(
        header_name,
        req.headers
          .get(header_name)
          .map(|v| v.as_bytes())
          .unwrap_or(&[]),
      );
    });

    key.finalize()
  }
}
