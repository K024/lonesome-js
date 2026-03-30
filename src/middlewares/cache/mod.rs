use std::sync::Arc;
mod handler;

use async_trait::async_trait;
use cel::{Program, Value};
use pingora::proxy::Session;
use serde::Deserialize;

use crate::matcher::cel_session_context::ensure_context;
use crate::middlewares::Middleware;
use crate::proxy::cache::ProxyCacheHandler;
use crate::proxy::ctx::ProxyCtx;
use handler::CacheHandler;

#[derive(Clone, Debug, Deserialize)]
pub struct CacheConfig {
  pub max_ttl_secs: Option<u64>,
  pub max_file_size_bytes: Option<usize>,
  pub inject_cache_headers: Option<bool>,
  pub rule: Option<String>,
}

impl CacheConfig {
  pub fn validate(&self) -> Result<(), String> {
    if let Some(ttl) = self.max_ttl_secs {
      if ttl == 0 {
        return Err("middleware cache.max_ttl_secs must be > 0".to_string());
      }
    }

    Ok(())
  }
}

pub struct CacheMiddleware {
  handler: Arc<dyn ProxyCacheHandler>,
  cel_program: Option<Program>,
}

impl CacheMiddleware {
  pub fn from_config(cfg: CacheConfig) -> Result<Self, String> {
    cfg.validate()?;

    let cel_program = if let Some(expr) = &cfg.rule {
      Some(
        Program::compile(expr)
          .map_err(|e| format!("failed to compile cache rule '{expr}': {e}"))?,
      )
    } else {
      None
    };

    Ok(Self {
      handler: Arc::new(CacheHandler::new(
        cfg.max_ttl_secs.unwrap_or(3600),
        cfg.max_file_size_bytes,
        cfg.inject_cache_headers.unwrap_or(true),
      )),
      cel_program,
    })
  }

  fn should_apply(&self, proxy_ctx: &mut ProxyCtx, session: &Session) -> bool {
    let Some(program) = &self.cel_program else {
      return true;
    };

    let ctx = ensure_context(session, proxy_ctx);
    matches!(program.execute(ctx), Ok(Value::Bool(true)))
  }
}

#[async_trait]
impl Middleware for CacheMiddleware {
  async fn early_request_filter(
    &self,
    proxy_ctx: &mut ProxyCtx,
    session: &mut Session,
  ) -> Result<(), String> {
    if !self.should_apply(proxy_ctx, session) {
      return Ok(());
    }

    proxy_ctx.cache_handler = Some(self.handler.clone());
    Ok(())
  }
}

pub async fn purge_route_cache_namespace(route_id: &str) -> Result<(), String> {
  handler::purge_route_namespace(route_id).await
}
