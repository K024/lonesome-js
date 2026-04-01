use async_trait::async_trait;
use pingora::http::ResponseHeader;
use pingora::protocols::Digest;
use pingora::proxy::Session;
use pingora::upstreams::peer::HttpPeer;
use pingora::{Error, ErrorType, Result};
use serde::Deserialize;

use crate::middlewares::Middleware;
use crate::proxy::ctx::ProxyCtx;
use crate::upstream::lb::observe_backend_health;
use crate::upstream::upstream::UpstreamState;

#[derive(Clone, Debug, Deserialize)]
pub struct HealthCheckConfig {
  pub retries: Option<i32>,
  pub failure_window_ms: Option<i64>,
  pub max_attempts: Option<i64>,
  pub include_http_errors: Option<bool>,
}

impl HealthCheckConfig {
  pub fn validate(&self) -> Result<(), String> {
    if self.retries.unwrap_or(0) < 0 {
      return Err("middleware health_check.retries must be >= 0".to_string());
    }

    if self.failure_window_ms.unwrap_or(10_000) <= 0 {
      return Err("middleware health_check.failure_window_ms must be > 0".to_string());
    }

    if self.max_attempts.unwrap_or(1) < 0 {
      return Err("middleware health_check.max_attempts must be >= 0".to_string());
    }

    Ok(())
  }
}

pub struct HealthCheckMiddleware {
  retries: i32,
  failure_window_ms: i64,
  max_attempts: i64,
  include_http_errors: bool,
}

impl HealthCheckMiddleware {
  pub fn from_config(cfg: HealthCheckConfig) -> Result<Self, String> {
    cfg.validate()?;
    Ok(Self {
      retries: cfg.retries.unwrap_or(0),
      failure_window_ms: cfg.failure_window_ms.unwrap_or(10_000),
      max_attempts: cfg.max_attempts.unwrap_or(1),
      include_http_errors: cfg.include_http_errors.unwrap_or(false),
    })
  }

  fn mark_success(&self, proxy_ctx: &ProxyCtx) {
    if let Some(upstream_state) = &proxy_ctx.upstream_state {
      if let Some(backend) = &upstream_state.last_backend {
        let now = chrono::Utc::now().timestamp_millis();
        observe_backend_health(
          &backend,
          true,
          now,
          self.failure_window_ms,
          self.max_attempts,
        );
      }
    }
  }

  fn mark_failure(&self, proxy_ctx: &ProxyCtx) {
    if let Some(upstream_state) = &proxy_ctx.upstream_state {
      if let Some(backend) = &upstream_state.last_backend {
        let now = chrono::Utc::now().timestamp_millis();
        observe_backend_health(
          &backend,
          false,
          now,
          self.failure_window_ms,
          self.max_attempts,
        );
      }
    }
  }
}

#[async_trait]
impl Middleware for HealthCheckMiddleware {
  async fn early_request_filter(
    &self,
    proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
  ) -> Result<()> {
    if proxy_ctx.upstream_state.is_some() {
      return Error::e_explain(
        ErrorType::InternalError,
        "multiple health checks are not allowed",
      );
    }

    proxy_ctx.upstream_state = Some(UpstreamState {
      retries: 0,
      last_endpoint_index: None,
      last_backend: None,
    });
    Ok(())
  }

  async fn connected_to_upstream(
    &self,
    proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _reused: bool,
    _peer: &HttpPeer,
    _digest: Option<&Digest>,
  ) -> Result<()> {
    self.mark_success(proxy_ctx);
    Ok(())
  }

  fn fail_to_connect(
    &self,
    proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _peer: &HttpPeer,
    mut error: Box<Error>,
  ) -> Result<Box<Error>> {
    self.mark_failure(proxy_ctx);

    if let Some(state) = proxy_ctx.upstream_state.as_mut() {
      if state.retries < self.retries {
        state.retries += 1;
        error.set_retry(true);
      }
    }

    Ok(error)
  }

  async fn upstream_response_filter(
    &self,
    proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    upstream_response: &mut ResponseHeader,
  ) -> Result<()> {
    if self.include_http_errors {
      if upstream_response.status.is_server_error() {
        self.mark_failure(proxy_ctx);
      }
    }

    Ok(())
  }
}
