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

#[derive(Clone, Debug)]
pub struct StartupConfig {
  pub threads: Option<usize>,
  pub work_stealing: Option<bool>,
  pub listeners: Vec<StartupListenerConfig>,
}

impl StartupConfig {
  pub fn validate(&self) -> Result<(), String> {
    if self.listeners.is_empty() {
      return Err("startup.listeners cannot be empty".to_string());
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
