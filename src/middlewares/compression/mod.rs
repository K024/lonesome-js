use async_trait::async_trait;
use cel::{Program, Value};
use pingora::modules::http::compression::ResponseCompression;
use pingora::protocols::http::compression::Algorithm;
use pingora::proxy::Session;
use serde::Deserialize;

use crate::matcher::cel_session_context::ensure_context;
use crate::middlewares::Middleware;
use crate::proxy::ctx::ProxyCtx;

#[derive(Clone, Debug, Deserialize, Default)]
pub struct CompressionConfig {
  pub gzip: Option<u32>,
  pub br: Option<u32>,
  pub zstd: Option<u32>,
  pub decompress_upstream: Option<bool>,
  pub preserve_etag: Option<bool>,
  pub rule: Option<String>,
}

impl CompressionConfig {
  pub fn validate(&self) -> Result<(), String> {
    if let Some(level) = self.gzip {
      validate_level("gzip", level)?;
    }
    if let Some(level) = self.br {
      validate_level("br", level)?;
    }
    if let Some(level) = self.zstd {
      validate_level("zstd", level)?;
    }

    Ok(())
  }
}

fn validate_level(name: &str, level: u32) -> Result<(), String> {
  if level > 11 {
    return Err(format!("middleware compression.{name} must be within [0, 11]"));
  }
  Ok(())
}

pub struct CompressionMiddleware {
  cfg: CompressionConfig,
  cel_program: Option<Program>,
}

impl CompressionMiddleware {
  pub fn from_config(cfg: CompressionConfig) -> Result<Self, String> {
    cfg.validate()?;

    let cel_program = if let Some(expr) = &cfg.rule {
      Some(
        Program::compile(expr)
          .map_err(|e| format!("failed to compile compression rule '{expr}': {e}"))?,
      )
    } else {
      None
    };

    Ok(Self { cfg, cel_program })
  }

  fn should_apply(&self, proxy_ctx: &mut ProxyCtx, session: &Session) -> bool {
    let Some(program) = &self.cel_program else {
      return true;
    };

    let ctx = ensure_context(session, proxy_ctx);
    matches!(program.execute(ctx), Ok(Value::Bool(true)))
  }

  fn apply_downstream(&self, session: &mut Session) -> Result<(), String> {
    let Some(compression) = session.downstream_modules_ctx.get_mut::<ResponseCompression>() else {
      return Err("downstream compression module is not initialized".to_string());
    };

    if let Some(level) = self.cfg.gzip {
      compression.adjust_algorithm_level(Algorithm::Gzip, level);
    }
    if let Some(level) = self.cfg.br {
      compression.adjust_algorithm_level(Algorithm::Brotli, level);
    }
    if let Some(level) = self.cfg.zstd {
      compression.adjust_algorithm_level(Algorithm::Zstd, level);
    }
    if let Some(enabled) = self.cfg.preserve_etag {
      compression.adjust_preserve_etag(enabled);
    }

    Ok(())
  }

  fn apply_upstream(&self, session: &mut Session) {
    if let Some(enabled) = self.cfg.decompress_upstream {
      session.upstream_compression.adjust_decompression(enabled);
    }
    if let Some(enabled) = self.cfg.preserve_etag {
      session.upstream_compression.adjust_preserve_etag(enabled);
    }
  }
}

#[async_trait]
impl Middleware for CompressionMiddleware {
  async fn early_request_filter(
    &self,
    proxy_ctx: &mut ProxyCtx,
    session: &mut Session,
  ) -> Result<(), String> {
    if !self.should_apply(proxy_ctx, session) {
      return Ok(());
    }

    self.apply_downstream(session)?;
    self.apply_upstream(session);
    Ok(())
  }
}
