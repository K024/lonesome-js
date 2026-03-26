#[derive(Clone, Debug)]
pub enum StartupListenerConfig {
  Tcp {
    addr: String,
  },
  Tls {
    addr: String,
    cert_path: String,
    key_path: String,
  },
  #[cfg(unix)]
  Unix {
    path: String,
  },
}

#[derive(Clone, Debug)]
pub struct StartupConfig {
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
          if cert_path.trim().is_empty() {
            return Err("tls listener cert_path cannot be empty".to_string());
          }
          if key_path.trim().is_empty() {
            return Err("tls listener key_path cannot be empty".to_string());
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
