use std::sync::Arc;
use std::time::Instant;

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
  /// Set by the access_log middleware at request start; used to compute latency.
  pub access_log_start: Option<Instant>,
  pub sni_host_policy: SniHostPolicy,
  pub error_pages: Arc<ErrorPageStore>,
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
      access_log_start: None,
      sni_host_policy,
      error_pages,
    }
  }

  pub fn reset_for_request(&mut self) {
    self.route_id.clear();
    self.current_route = None;
    self.session_cel_context = None;
    self.cache_handler = None;
    self.upstream_state = None;
    self.extensions.clear();
    self.access_log_start = None;
  }

  pub fn set_route(&mut self, route: Arc<Route>) {
    self.route_id = route.id.clone();
    self.current_route = Some(route);
  }

  pub fn route(&self) -> Option<&Arc<Route>> {
    self.current_route.as_ref()
  }
}
