use std::sync::Arc;

use arc_swap::ArcSwap;

use crate::proxy::ctx::ProxyCtx;
use crate::route::Route;

#[derive(Default)]
pub struct RouteTable {
  routes: Vec<Arc<Route>>,
}

impl RouteTable {
  pub fn upsert_route(&self, route: Route) -> Arc<Self> {
    let mut routes = self.routes.clone();
    let route = Arc::new(route);

    if let Some(existing_idx) = routes.iter().position(|r| r.id == route.id) {
      routes[existing_idx] = route;
    } else {
      routes.push(route);
    }

    routes.sort_by(|a, b| b.priority.cmp(&a.priority).then_with(|| a.id.cmp(&b.id)));

    Arc::new(Self { routes })
  }

  pub fn remove_route(&self, route_id: &str) -> (Arc<Self>, bool) {
    let mut routes = self.routes.clone();
    let before = routes.len();
    routes.retain(|r| r.id != route_id);
    let removed = before != routes.len();
    (Arc::new(Self { routes }), removed)
  }

  pub fn find_first_match(
    &self,
    session: &pingora::proxy::Session,
    proxy_ctx: &mut ProxyCtx,
  ) -> Option<Arc<Route>> {
    self
      .routes
      .iter()
      .find(|r| r.matches(session, proxy_ctx))
      .cloned()
  }

  pub fn route_count(&self) -> usize {
    self.routes.len()
  }
}

#[derive(Clone, Default)]
pub struct SharedRouteTable {
  snapshot: Arc<ArcSwap<RouteTable>>,
}

impl SharedRouteTable {
  pub fn new() -> Self {
    Self {
      snapshot: Arc::new(ArcSwap::from_pointee(RouteTable::default())),
    }
  }

  pub fn read_snapshot(&self) -> Arc<RouteTable> {
    self.snapshot.load_full()
  }

  pub fn upsert_route(&self, route: Route) {
    let current = self.read_snapshot();
    let next = current.upsert_route(route);
    self.snapshot.store(next);
  }

  pub fn remove_route(&self, route_id: &str) -> bool {
    let current = self.read_snapshot();
    let (next, removed) = current.remove_route(route_id);
    self.snapshot.store(next);
    removed
  }

  pub fn route_count(&self) -> usize {
    self.read_snapshot().route_count()
  }
}
