use std::sync::LazyLock;
use std::time::Duration;

use async_trait::async_trait;
use cel::{Program, Value};
use pingora::http::ResponseHeader;
use pingora::proxy::Session;
use pingora::Result;
use pingora_limits::rate::Rate;
use serde::Deserialize;

use crate::matcher::cel_session_context::ensure_context;
use crate::middlewares::middleware::middleware_internal_error;
use crate::middlewares::Middleware;
use crate::proxy::ctx::ProxyCtx;

static OBSERVE_SECONDS: isize = 10;
static RATE_LIMITER: LazyLock<Rate> =
  LazyLock::new(|| Rate::new(Duration::from_secs(OBSERVE_SECONDS as u64)));

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum LimitModeConfig {
  RemoteIp,
  Header { header_name: String },
  Expression { key: String },
}

#[derive(Clone, Debug, Deserialize)]
pub struct RateLimitConfig {
  #[serde(flatten)]
  pub mode: LimitModeConfig,
  pub max_rps: f64,
  pub status: Option<u16>,
  pub include_headers: Option<bool>,
  pub rule: Option<String>,
}

impl RateLimitConfig {
  pub fn validate(&self) -> Result<(), String> {
    match &self.mode {
      LimitModeConfig::RemoteIp => {}
      LimitModeConfig::Header { header_name } => {
        if header_name.trim().is_empty() {
          return Err("middleware rate_limit.header_name cannot be empty".to_string());
        }
      }
      LimitModeConfig::Expression { key } => {
        if key.trim().is_empty() {
          return Err("middleware rate_limit.key cannot be empty".to_string());
        }
      }
    }

    if self.max_rps <= 0.0 {
      return Err("middleware rate_limit.max_rps must be > 0".to_string());
    }

    if let Some(status) = self.status {
      if !(100..=999).contains(&status) {
        return Err("middleware rate_limit.status must be within [100, 999]".to_string());
      }
    }

    Ok(())
  }
}

pub struct RateLimitMiddleware {
  mode: LimitMode,
  max_requests_per_observe: isize,
  status: u16,
  include_headers: bool,
  cel_program: Option<Program>,
}

enum LimitMode {
  RemoteIp,
  Header { header_name: String },
  Expression { key_program: Program },
}

impl RateLimitMiddleware {
  pub fn from_config(cfg: RateLimitConfig) -> Result<Self, String> {
    cfg.validate()?;

    let mode = match cfg.mode {
      LimitModeConfig::RemoteIp => LimitMode::RemoteIp,
      LimitModeConfig::Header { header_name } => LimitMode::Header { header_name },
      LimitModeConfig::Expression { key } => {
        let key_program = Program::compile(&key)
          .map_err(|e| format!("failed to compile rate_limit.key '{key}': {e}"))?;
        LimitMode::Expression { key_program }
      }
    };

    let cel_program = if let Some(expr) = cfg.rule {
      Some(
        Program::compile(&expr)
          .map_err(|e| format!("failed to compile rate_limit rule '{expr}': {e}"))?,
      )
    } else {
      None
    };

    Ok(Self {
      mode,
      max_requests_per_observe: (cfg.max_rps * OBSERVE_SECONDS as f64).round() as isize,
      status: cfg.status.unwrap_or(429),
      include_headers: cfg.include_headers.unwrap_or(true),
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

  fn key_value(&self, proxy_ctx: &mut ProxyCtx, session: &Session) -> Option<String> {
    match &self.mode {
      LimitMode::RemoteIp => match session.client_addr().map(|addr| addr.to_string()) {
        Some(v) if !v.is_empty() => Some(v.to_string()),
        _ => None,
      },
      LimitMode::Header { header_name } => session
        .req_header()
        .headers
        .get(header_name.as_str())
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned),
      LimitMode::Expression { key_program } => {
        let ctx = ensure_context(session, proxy_ctx);
        match key_program.execute(ctx) {
          Ok(Value::String(v)) => {
            if v.is_empty() {
              None
            } else {
              Some(v.to_string())
            }
          }
          Ok(Value::Int(v)) => Some(v.to_string()),
          Ok(Value::UInt(v)) => Some(v.to_string()),
          Ok(Value::Float(v)) => Some(v.to_string()),
          Ok(Value::Bool(v)) => Some(v.to_string()),
          _ => None,
        }
      }
    }
  }
}

#[async_trait]
impl Middleware for RateLimitMiddleware {
  async fn request_filter(&self, proxy_ctx: &mut ProxyCtx, session: &mut Session) -> Result<bool> {
    if !self.should_apply(proxy_ctx, session) {
      return Ok(false);
    }

    let key = self.key_value(proxy_ctx, session).unwrap_or_default();

    let curr_window_requests = RATE_LIMITER.observe(&key, 1);
    if curr_window_requests <= self.max_requests_per_observe {
      return Ok(false);
    }

    let mut header = ResponseHeader::build(self.status, Some(4))
      .map_err(|e| middleware_internal_error("rate_limit build response failed", e.to_string()))?;

    if self.include_headers {
      header
        .insert_header(
          "X-RateLimit-Limit",
          self.max_requests_per_observe.to_string(),
        )
        .map_err(|e| {
          middleware_internal_error("rate_limit insert X-RateLimit-Limit failed", e.to_string())
        })?;
      header
        .insert_header("X-RateLimit-Remaining", "0")
        .map_err(|e| {
          middleware_internal_error(
            "rate_limit insert X-RateLimit-Remaining failed",
            e.to_string(),
          )
        })?;
      header
        .insert_header("X-RateLimit-Reset", OBSERVE_SECONDS.to_string())
        .map_err(|e| {
          middleware_internal_error("rate_limit insert X-RateLimit-Reset failed", e.to_string())
        })?;
    }

    session.as_downstream_mut().set_keepalive(None);
    session
      .write_response_header(Box::new(header), true)
      .await
      .map_err(|e| middleware_internal_error("rate_limit write response failed", e.to_string()))?;

    Ok(true)
  }
}
