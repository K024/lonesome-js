#[derive(Clone, Debug)]
pub enum StartupListenerConfig {
  Tcp {
    addr: String,
  },
  Tls {
    addr: String,
    /// Optional: if absent, the TLS listener relies on the runtime cert store
    /// (a global default set via `updateCert('*')`).
    cert_path: Option<String>,
    key_path: Option<String>,
  },
  #[cfg(unix)]
  Unix {
    path: String,
  },
}

/// How the TLS SNI (when present) relates to the HTTP-level authority
/// (`:authority` / `Host` header) for routing and forwarding.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SniHostPolicy {
  /// Routing and matching use SNI first (then HTTP authority); the HTTP
  /// authority is forwarded to the upstream verbatim. This is the historical
  /// behavior. A mismatched SNI/Host can reach the upstream unchanged.
  LooseBySni,
  /// Routing and matching use the HTTP authority only (`:authority`, then the
  /// `Host` header); SNI is used solely for certificate selection.
  LooseByHeader,
  /// Routing and matching use the HTTP authority; a request whose SNI differs
  /// from the HTTP authority (both present) is rejected with 421 Misdirected
  /// Request. When both `:authority` and `Host` are present but disagree, the
  /// request is malformed (RFC 9113 §8.3.1) and rejected with 400.
  #[default]
  Strict,
  /// Routing and matching use SNI first (then HTTP authority); when an SNI is
  /// present the authority forwarded to the upstream (`Host` header and
  /// `:authority`) is rewritten to the SNI, preventing upstream vhost
  /// confusion without rejecting the request.
  StrictRewriteHeader,
}

impl SniHostPolicy {
  pub fn as_str(&self) -> &'static str {
    match self {
      SniHostPolicy::LooseBySni => "loose_by_sni",
      SniHostPolicy::LooseByHeader => "loose_by_header",
      SniHostPolicy::Strict => "strict",
      SniHostPolicy::StrictRewriteHeader => "strict_rewrite_header",
    }
  }
}

#[derive(Clone, Debug)]
pub struct StartupConfig {
  pub threads: Option<usize>,
  pub work_stealing: Option<bool>,
  pub listeners: Vec<StartupListenerConfig>,
  pub sni_host_policy: SniHostPolicy,
  /// Per-connection read timeout on the downstream (client) side.
  pub downstream_read_timeout_ms: Option<u64>,
  /// Per-connection write timeout on the downstream (client) side.
  pub downstream_write_timeout_ms: Option<u64>,
  /// Grace period in seconds before the final step of graceful shutdown.
  pub grace_period_seconds: Option<u64>,
  /// Timeout in seconds of the final step of graceful shutdown.
  pub graceful_shutdown_timeout_seconds: Option<u64>,
  /// Size of the keepalive pool for upstream connections.
  pub upstream_keepalive_pool_size: Option<usize>,
  /// Fail-safe cap on upstream retries.
  pub max_retries: Option<usize>,
  /// Serve HTTP/2 prior-knowledge (h2c) on plaintext TCP listeners.
  pub enable_h2c_downstream: Option<bool>,
}

impl StartupConfig {
  pub fn validate(&self) -> Result<(), String> {
    if self.listeners.is_empty() {
      return Err("startup.listeners cannot be empty".to_string());
    }

    if let Some(ms) = self.downstream_read_timeout_ms {
      if ms == 0 {
        return Err("startup.downstreamReadTimeoutMs must be > 0".to_string());
      }
    }
    if let Some(ms) = self.downstream_write_timeout_ms {
      if ms == 0 {
        return Err("startup.downstreamWriteTimeoutMs must be > 0".to_string());
      }
    }

    for listener in &self.listeners {
      match listener {
        StartupListenerConfig::Tcp { addr } => {
          if addr.trim().is_empty() {
            return Err("tcp listener addr cannot be empty".to_string());
          }
        }
        StartupListenerConfig::Tls {
          addr,
          cert_path,
          key_path,
        } => {
          if addr.trim().is_empty() {
            return Err("tls listener addr cannot be empty".to_string());
          }
          match (cert_path.as_deref(), key_path.as_deref()) {
            (Some(cert), Some(key)) => {
              if cert.trim().is_empty() {
                return Err("tls listener cert_path cannot be empty".to_string());
              }
              if key.trim().is_empty() {
                return Err("tls listener key_path cannot be empty".to_string());
              }
            }
            (None, None) => {
              // Allowed only when a global default cert is set via
              // updateCert('*') before start(); enforced in LonesomeRuntime::start.
            }
            _ => {
              return Err(
                "tls listener cert_path and key_path must be provided together".to_string(),
              );
            }
          }
        }
        #[cfg(unix)]
        StartupListenerConfig::Unix { path } => {
          if path.trim().is_empty() {
            return Err("unix listener path cannot be empty".to_string());
          }
        }
      }
    }

    Ok(())
  }
}
