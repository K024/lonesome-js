use std::fs::OpenOptions;
use std::io::Write;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use async_trait::async_trait;
use cel::{Program, Value};
use dashmap::DashMap;
use pingora::proxy::Session;
use pingora::{Error, Result};
use serde::Deserialize;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

use crate::matcher::cel_session_context::ensure_context;
use crate::middlewares::Middleware;
use crate::proxy::ctx::ProxyCtx;

#[derive(Clone, Debug, Deserialize)]
pub struct AccessLogConfig {
  /// Output format: `"text"` (default) or `"json"`.
  pub format: Option<String>,
  /// Path to the access log file. Required. Lines are appended and never
  /// written to the process stdio (which is shared with the host JS runtime).
  pub file: Option<String>,
  /// Optional CEL expression evaluated per request; its scalar result is
  /// included in the log line as the `ext` field (empty string when absent or
  /// evaluation fails).
  pub ext: Option<String>,
}

impl AccessLogConfig {
  pub fn validate(&self) -> Result<(), String> {
    if let Some(format) = &self.format {
      if format != "text" && format != "json" {
        return Err("middleware access_log.format must be 'text' or 'json'".to_string());
      }
    }
    let file = self.file.as_deref().unwrap_or("");
    if file.trim().is_empty() {
      return Err("middleware access_log.file is required".to_string());
    }
    if let Some(ext) = &self.ext {
      Program::compile(ext)
        .map_err(|e| format!("failed to compile access_log.ext expression '{ext}': {e}"))?;
    }
    Ok(())
  }
}

/// A per-file access log sink.
///
/// All middleware instances logging to the same path share one sink and one
/// dedicated writer task, so lines are never interleaved. The request path
/// only enqueues a line with `try_send` (no lock, no blocking file I/O); the
/// writer task runs on the same tokio runtime and does the actual appends.
struct AccessLogSink {
  path: String,
  tx: OnceLock<mpsc::Sender<String>>,
}

impl AccessLogSink {
  fn send_line(&self, line: String) {
    if let Some(tx) = self.tx.get() {
      let _ = tx.try_send(line);
      return;
    }

    // Lazy init on first use: this runs inside the pingora tokio runtime, so
    // the writer task is spawned onto that same runtime.
    let Some(handle) = tokio::runtime::Handle::try_current().ok() else {
      // Not in a tokio context (should not happen in practice): fall back to
      // a one-shot blocking append so the line is not silently lost.
      if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&self.path)
      {
        let _ = file.write_all(line.as_bytes());
      }
      return;
    };

    let (tx, rx) = mpsc::channel(1024);
    let path = self.path.clone();
    match self.tx.set(tx) {
      Ok(()) => {
        handle.spawn(access_log_writer(path, rx));
      }
      Err(tx) => {
        // Another thread initialized the sink first; drop the unused pair.
        drop(tx);
        drop(rx);
      }
    }
    let _ = self.tx.get().expect("sink sender set above").try_send(line);
  }
}

/// Dedicated writer task: owns the file handle and drains the line queue.
async fn access_log_writer(path: String, mut rx: mpsc::Receiver<String>) {
  let Ok(file) = tokio::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(&path)
    .await
  else {
    return;
  };
  let mut writer = tokio::io::BufWriter::new(file);
  while let Some(line) = rx.recv().await {
    if writer.write_all(line.as_bytes()).await.is_err() || writer.flush().await.is_err() {
      return;
    }
  }
}

fn sink_for(path: &str) -> Result<Arc<AccessLogSink>, String> {
  static SINKS: OnceLock<DashMap<String, Arc<AccessLogSink>>> = OnceLock::new();

  // Fail early if the file cannot be opened for appending.
  OpenOptions::new()
    .create(true)
    .append(true)
    .open(path)
    .map_err(|e| format!("failed to open access log file '{path}': {e}"))?;

  let map = SINKS.get_or_init(DashMap::new);
  if let Some(existing) = map.get(path) {
    return Ok(existing.clone());
  }
  let sink = Arc::new(AccessLogSink {
    path: path.to_string(),
    tx: OnceLock::new(),
  });
  map.insert(path.to_string(), sink.clone());
  Ok(sink)
}

pub struct AccessLogMiddleware {
  json: bool,
  sink: Arc<AccessLogSink>,
  ext_program: Option<Program>,
}

impl AccessLogMiddleware {
  pub fn from_config(cfg: AccessLogConfig) -> Result<Self, String> {
    cfg.validate()?;
    let file = cfg.file.as_deref().unwrap_or_default();
    let ext_program = cfg
      .ext
      .as_deref()
      .map(|expr| {
        Program::compile(expr)
          .map_err(|e| format!("failed to compile access_log.ext expression '{expr}': {e}"))
      })
      .transpose()?;
    Ok(Self {
      json: cfg.format.as_deref() == Some("json"),
      sink: sink_for(file)?,
      ext_program,
    })
  }

  fn eval_ext(&self, proxy_ctx: &mut ProxyCtx, session: &Session) -> String {
    let Some(program) = &self.ext_program else {
      return String::new();
    };
    let ctx = ensure_context(session, proxy_ctx);
    match program.execute(ctx) {
      Ok(Value::String(v)) => v.to_string(),
      Ok(Value::Int(v)) => v.to_string(),
      Ok(Value::UInt(v)) => v.to_string(),
      Ok(Value::Float(v)) => v.to_string(),
      Ok(Value::Bool(v)) => v.to_string(),
      _ => String::new(),
    }
  }
}

/// Middleware-private per-request state, stored in `ProxyCtx.extensions`
/// (type-keyed) so `ProxyCtx` stays free of single-middleware concerns. Holds
/// the `Instant` captured at request start for latency computation.
#[derive(Clone, Copy, Debug)]
struct AccessLogStart(Instant);

#[async_trait]
impl Middleware for AccessLogMiddleware {
  async fn early_request_filter(
    &self,
    proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
  ) -> Result<()> {
    proxy_ctx.extensions.insert(AccessLogStart(Instant::now()));
    Ok(())
  }

  async fn logging(
    &self,
    proxy_ctx: &mut ProxyCtx,
    session: &mut Session,
    error: Option<&Error>,
  ) -> Result<()> {
    let start = proxy_ctx
      .extensions
      .get::<AccessLogStart>()
      .map(|s| s.0)
      .unwrap_or_else(Instant::now);
    let latency_ms = start.elapsed().as_millis();
    let ts = chrono::Utc::now().to_rfc3339();
    let method = session.req_header().method.as_str();
    let path = session.req_header().uri.to_string();
    let status = session
      .response_written()
      .map(|h| h.status.as_u16())
      .unwrap_or(0);
    let upstream = proxy_ctx
      .upstream_state
      .as_ref()
      .and_then(|s| s.last_backend.as_ref())
      .map(|b| b.addr.to_string())
      .unwrap_or_default();
    let ext = self.eval_ext(proxy_ctx, session);

    let line = if self.json {
      let entry = serde_json::json!({
        "ts": ts,
        "method": method,
        "path": path,
        "status": status,
        "latency_ms": latency_ms,
        "upstream": upstream,
        "ext": ext,
        "error": error.map(|e| e.to_string()),
      });
      format!("{entry}\n")
    } else {
      let ext_suffix = if ext.is_empty() {
        String::new()
      } else {
        format!(" ext={ext}")
      };
      let error_suffix = error.map(|e| format!(" error={e}")).unwrap_or_default();
      format!(
        "{ts} {method} {path} status={status} latency={latency_ms}ms upstream={upstream}{ext_suffix}{error_suffix}\n"
      )
    };

    // Best-effort: enqueue without blocking the request path.
    self.sink.send_line(line);

    Ok(())
  }
}
