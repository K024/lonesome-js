use std::sync::Arc;

use pingora::lb::Extensions;

use crate::matcher::cel_session_context::SessionCelContext;
use crate::proxy::cache::ProxyCacheHandler;
use crate::route::Route;
use crate::upstream::upstream::UpstreamState;

pub struct ProxyCtx {
  pub route_id: String,
  pub current_route: Option<Arc<Route>>,
  pub session_cel_context: Option<SessionCelContext>,
  pub cache_handler: Option<Arc<dyn ProxyCacheHandler>>,
  pub upstream_state: Option<UpstreamState>,
  pub extensions: Extensions,
}

impl ProxyCtx {
  pub fn new() -> Self {
    Self {
      route_id: String::new(),
      current_route: None,
      session_cel_context: None,
      cache_handler: None,
      upstream_state: None,
      extensions: Extensions::new(),
    }
  }

  pub fn reset_for_request(&mut self) {
    self.route_id.clear();
    self.current_route = None;
    self.session_cel_context = None;
    self.cache_handler = None;
    self.upstream_state = None;
    self.extensions.clear();
  }

  pub fn set_route(&mut self, route: Arc<Route>) {
    self.route_id = route.id.clone();
    self.current_route = Some(route);
  }

  pub fn route(&self) -> Option<&Arc<Route>> {
    self.current_route.as_ref()
  }
}
