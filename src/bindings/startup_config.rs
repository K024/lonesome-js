use napi_derive::napi;

use crate::config::{
  StartupConfig as CoreStartupConfig, StartupListenerConfig as CoreStartupListenerConfig,
};

#[napi(object)]
pub struct StartupConfig {
  pub threads: Option<u32>,
  pub work_stealing: Option<bool>,
  #[napi(ts_type = "StartupListenerConfig[]")]
  pub listeners: Vec<StartupListenerConfig>,
}

#[napi(object)]
pub struct StartupListenerConfig {
  #[napi(ts_type = "'tcp' | 'tls' | 'unix'")]
  pub kind: String,
  pub addr: String,
  pub cert_path: Option<String>,
  pub key_path: Option<String>,
}

impl TryFrom<StartupConfig> for CoreStartupConfig {
  type Error = String;

  fn try_from(value: StartupConfig) -> Result<Self, Self::Error> {
    let listeners = value
      .listeners
      .into_iter()
      .map(|item| match item.kind.as_str() {
        "tcp" => Ok(CoreStartupListenerConfig::Tcp { addr: item.addr }),
        "tls" => {
          let cert_path = item
            .cert_path
            .ok_or_else(|| "startup listener tls.cert_path is required".to_string())?;
          let key_path = item
            .key_path
            .ok_or_else(|| "startup listener tls.key_path is required".to_string())?;

          Ok(CoreStartupListenerConfig::Tls {
            addr: item.addr,
            cert_path,
            key_path,
          })
        }
        #[cfg(unix)]
        "unix" => Ok(CoreStartupListenerConfig::Unix { path: item.addr }),
        other => Err(format!("unsupported startup listener kind '{other}'")),
      })
      .collect::<Result<Vec<_>, _>>()?;

    Ok(CoreStartupConfig {
      threads: value.threads.map(|v| v as usize),
      work_stealing: value.work_stealing,
      listeners,
    })
  }
}
