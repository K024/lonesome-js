use std::sync::Arc;

use crate::matcher::cel_session_context::SessionCelContext;
use crate::route::Route;

pub struct ProxyCtx {
  pub route_id: String,
  pub current_route: Option<Arc<Route>>,
  pub session_cel_context: Option<SessionCelContext>,
}

impl ProxyCtx {
  pub fn new() -> Self {
    Self {
      route_id: String::new(),
      current_route: None,
      session_cel_context: None,
    }
  }

  pub fn reset_for_request(&mut self) {
    self.route_id.clear();
    self.current_route = None;
    self.session_cel_context = None;
  }

  pub fn set_route(&mut self, route: Arc<Route>) {
    self.route_id = route.id.clone();
    self.current_route = Some(route);
  }

  pub fn route(&self) -> Option<&Arc<Route>> {
    self.current_route.as_ref()
  }
}
