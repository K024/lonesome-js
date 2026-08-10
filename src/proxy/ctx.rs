use std::sync::Arc;

use bytes::Bytes;
use pingora::lb::Extensions;

use crate::config::SniHostPolicy;
use crate::matcher::cel_session_context::SessionCelContext;
use crate::proxy::cache::ProxyCacheHandler;
use crate::route::Route;
use crate::server::error_page_store::ErrorPageStore;
use crate::upstream::upstream::UpstreamState;

pub struct ProxyCtx {
  pub route_id: String,
  pub current_route: Option<Arc<Route>>,
  pub session_cel_context: Option<SessionCelContext>,
  pub cache_handler: Option<Arc<dyn ProxyCacheHandler>>,
  pub upstream_state: Option<UpstreamState>,
  pub extensions: Extensions,
  pub sni_host_policy: SniHostPolicy,
  pub error_pages: Arc<ErrorPageStore>,
  /// Set by a middleware that takes over the upstream response body (e.g. the
  /// `rewrite_error_page` middleware). The swap is applied centrally by
  /// `LonesomeProxy::upstream_response_body_filter`: the first upstream body
  /// chunk is replaced with the replacement, the remaining chunks are dropped.
  pub response_body_override: Option<ResponseBodyOverride>,
}

/// How a middleware override of the upstream response body is applied by the
/// upstream response body filter. Mirrors pingap's `FullyReplaced` plugin
/// result: the middleware fully owns the body once it takes over.
pub enum ResponseBodyOverride {
  /// The first upstream body chunk is replaced with this body.
  Replace(Bytes),
  /// The replacement was already emitted; remaining upstream chunks are dropped.
  DropRemaining,
}

impl ProxyCtx {
  pub fn new(sni_host_policy: SniHostPolicy, error_pages: Arc<ErrorPageStore>) -> Self {
    Self {
      route_id: String::new(),
      current_route: None,
      session_cel_context: None,
      cache_handler: None,
      upstream_state: None,
      extensions: Extensions::new(),
      sni_host_policy,
      error_pages,
      response_body_override: None,
    }
  }

  pub fn reset_for_request(&mut self) {
    self.route_id.clear();
    self.current_route = None;
    self.session_cel_context = None;
    self.cache_handler = None;
    self.upstream_state = None;
    self.extensions.clear();
    self.response_body_override = None;
  }

  pub fn set_route(&mut self, route: Arc<Route>) {
    self.route_id = route.id.clone();
    self.current_route = Some(route);
  }

  pub fn route(&self) -> Option<&Arc<Route>> {
    self.current_route.as_ref()
  }
}
