use pingora::upstreams::peer::HttpPeer;

use crate::config::RouteConfig;
use crate::matcher::Matcher;
use crate::middlewares::registry::build_middleware;
use crate::middlewares::Middleware;
use crate::proxy::ctx::ProxyCtx;
use crate::upstream::UpstreamPool;

pub struct Route {
  pub id: String,
  pub priority: i32,
  matcher: Matcher,
  middlewares: Vec<Box<dyn Middleware>>,
  upstream_pool: UpstreamPool,
}

impl Route {
  pub fn from_config(cfg: RouteConfig) -> Result<Self, String> {
    cfg.validate()?;
    let priority = cfg.effective_priority();

    let matcher = Matcher::from_cel(cfg.matcher.rule.clone())?;

    let mut middlewares = Vec::with_capacity(cfg.middlewares.len());
    for mw in &cfg.middlewares {
      middlewares.push(build_middleware(mw)?);
    }

    let upstream_pool = UpstreamPool::from_config(&cfg.upstreams, cfg.load_balancer.clone())?;

    Ok(Self {
      id: cfg.id,
      priority,
      matcher,
      middlewares,
      upstream_pool,
    })
  }

  pub fn matches(&self, session: &pingora::proxy::Session, proxy_ctx: &mut ProxyCtx) -> bool {
    self.matcher.matches(session, proxy_ctx)
  }

  pub fn middlewares(&self) -> std::slice::Iter<'_, Box<dyn Middleware>> {
    self.middlewares.iter()
  }

  pub fn select_upstream_peer(&self, proxy_ctx: &ProxyCtx) -> Result<Box<HttpPeer>, String> {
    self.upstream_pool.select_peer(proxy_ctx, &self.id)
  }
}
