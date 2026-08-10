use napi_derive::napi;

use crate::config::{
  SniHostPolicy, StartupConfig as CoreStartupConfig,
  StartupListenerConfig as CoreStartupListenerConfig,
};

#[napi(object)]
pub struct StartupConfig {
  pub threads: Option<u32>,
  pub work_stealing: Option<bool>,
  #[napi(ts_type = "StartupListenerConfig[]")]
  pub listeners: Vec<StartupListenerConfig>,
  #[napi(ts_type = "'loose_by_sni' | 'loose_by_header' | 'strict' | 'strict_rewrite_header'")]
  pub sni_host_policy: Option<String>,
  pub downstream_read_timeout_ms: Option<u32>,
  pub downstream_write_timeout_ms: Option<u32>,
  pub grace_period_seconds: Option<u32>,
  pub graceful_shutdown_timeout_seconds: Option<u32>,
  pub upstream_keepalive_pool_size: Option<u32>,
  pub max_retries: Option<u32>,
  pub enable_h2c_downstream: Option<bool>,
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
        "tls" => Ok(CoreStartupListenerConfig::Tls {
          addr: item.addr,
          cert_path: item.cert_path,
          key_path: item.key_path,
        }),
        #[cfg(unix)]
        "unix" => Ok(CoreStartupListenerConfig::Unix { path: item.addr }),
        other => Err(format!("unsupported startup listener kind '{other}'")),
      })
      .collect::<Result<Vec<_>, _>>()?;

    let sni_host_policy = match value.sni_host_policy.as_deref() {
      None | Some("strict") => SniHostPolicy::Strict,
      Some("loose_by_sni") => SniHostPolicy::LooseBySni,
      Some("loose_by_header") => SniHostPolicy::LooseByHeader,
      Some("strict_rewrite_header") => SniHostPolicy::StrictRewriteHeader,
      Some(other) => {
        return Err(format!(
          "unsupported startup sniHostPolicy '{other}' \
           (expected 'loose_by_sni' | 'loose_by_header' | 'strict' | 'strict_rewrite_header')"
        ));
      }
    };

    Ok(CoreStartupConfig {
      threads: value.threads.map(|v| v as usize),
      work_stealing: value.work_stealing,
      listeners,
      sni_host_policy,
      downstream_read_timeout_ms: value.downstream_read_timeout_ms.map(u64::from),
      downstream_write_timeout_ms: value.downstream_write_timeout_ms.map(u64::from),
      grace_period_seconds: value.grace_period_seconds.map(u64::from),
      graceful_shutdown_timeout_seconds: value.graceful_shutdown_timeout_seconds.map(u64::from),
      upstream_keepalive_pool_size: value.upstream_keepalive_pool_size.map(|v| v as usize),
      max_retries: value.max_retries.map(|v| v as usize),
      enable_h2c_downstream: value.enable_h2c_downstream,
    })
  }
}
