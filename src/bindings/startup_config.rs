use napi_derive::napi;

use crate::config::{StartupConfig, StartupListenerConfig};

#[napi(object)]
pub struct NapiStartupConfig {
  pub threads: Option<u32>,
  pub work_stealing: Option<bool>,
  pub listeners: Vec<NapiStartupListenerConfig>,
}

#[napi(object)]
pub struct NapiStartupListenerConfig {
  pub kind: String,
  pub addr: Option<String>,
  pub cert_path: Option<String>,
  pub key_path: Option<String>,
  pub path: Option<String>,
}

impl TryFrom<NapiStartupConfig> for StartupConfig {
  type Error = String;

  fn try_from(value: NapiStartupConfig) -> Result<Self, Self::Error> {
    let listeners = value
      .listeners
      .into_iter()
      .map(|item| match item.kind.as_str() {
        "tcp" => {
          let addr = item
            .addr
            .ok_or_else(|| "startup listener tcp.addr is required".to_string())?;
          Ok(StartupListenerConfig::Tcp { addr })
        }
        "tls" => {
          let addr = item
            .addr
            .ok_or_else(|| "startup listener tls.addr is required".to_string())?;
          let cert_path = item
            .cert_path
            .ok_or_else(|| "startup listener tls.cert_path is required".to_string())?;
          let key_path = item
            .key_path
            .ok_or_else(|| "startup listener tls.key_path is required".to_string())?;

          Ok(StartupListenerConfig::Tls {
            addr,
            cert_path,
            key_path,
          })
        }
        #[cfg(unix)]
        "unix" => {
          let path = item
            .path
            .ok_or_else(|| "startup listener unix.path is required".to_string())?;
          Ok(StartupListenerConfig::Unix { path })
        }
        other => Err(format!("unsupported startup listener kind '{other}'")),
      })
      .collect::<Result<Vec<_>, _>>()?;

    Ok(StartupConfig {
      threads: value.threads.map(|v| v as usize),
      work_stealing: value.work_stealing,
      listeners,
    })
  }
}
