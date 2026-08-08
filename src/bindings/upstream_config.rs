use napi_derive::napi;

use crate::config::{
  LoadBalancerAlgorithm as CoreLoadBalancerAlgorithm, LoadBalancerConfig as CoreLoadBalancerConfig,
  UpstreamAddressConfig as CoreUpstreamAddressConfig, UpstreamConfig as CoreUpstreamConfig,
};

#[napi(object, js_name = "LoadBalancerConfig")]
pub struct LoadBalancerConfig {
  #[napi(ts_type = "'round_robin' | 'rr' | 'consistent_hash' | 'consistent' | 'ch'")]
  pub algorithm: Option<String>,
  pub max_iterations: Option<u32>,
  pub hash_key_rule: Option<String>,
}

#[napi(object, js_name = "UpstreamConfig")]
pub struct UpstreamConfig {
  #[napi(ts_type = "'tcp' | 'unix' | 'virtual_js'")]
  pub kind: Option<String>,
  pub address: String,
  pub tls: Option<bool>,
  #[napi(js_name = "h2c")]
  pub h2_c: Option<bool>,
  pub sni: Option<String>,
  pub weight: Option<u32>,
  pub connect_timeout_ms: Option<u32>,
  pub read_timeout_ms: Option<u32>,
  pub write_timeout_ms: Option<u32>,
  pub idle_timeout_ms: Option<u32>,
  pub verify_cert: Option<bool>,
  pub client_cert_pem: Option<String>,
  pub client_key_pem: Option<String>,
  pub ca_cert_pem: Option<String>,
}

impl TryFrom<LoadBalancerConfig> for CoreLoadBalancerConfig {
  type Error = String;

  fn try_from(value: LoadBalancerConfig) -> Result<Self, Self::Error> {
    let algorithm = match value.algorithm.as_deref().unwrap_or("round_robin") {
      "round_robin" | "rr" => CoreLoadBalancerAlgorithm::RoundRobin,
      "consistent_hash" | "consistent" | "ch" => CoreLoadBalancerAlgorithm::ConsistentHash,
      other => return Err(format!("unsupported lb.algorithm '{other}'")),
    };

    Ok(CoreLoadBalancerConfig {
      algorithm,
      max_iterations: value.max_iterations.unwrap_or(32) as usize,
      hash_key_rule: value.hash_key_rule.filter(|s| !s.trim().is_empty()),
    })
  }
}

impl TryFrom<UpstreamConfig> for CoreUpstreamConfig {
  type Error = String;

  fn try_from(value: UpstreamConfig) -> Result<Self, Self::Error> {
    let address = match value.kind.as_deref().unwrap_or("tcp") {
      "tcp" => CoreUpstreamAddressConfig::Tcp(value.address),
      #[cfg(unix)]
      "unix" => CoreUpstreamAddressConfig::Unix(value.address),
      "virtual_js" => CoreUpstreamAddressConfig::VirtualJs(value.address),
      other => return Err(format!("unsupported upstream kind '{other}'")),
    };

    Ok(CoreUpstreamConfig {
      address,
      tls: value.tls.unwrap_or(false),
      h2c: value.h2_c,
      sni: value.sni,
      weight: value.weight.unwrap_or(1),
      connect_timeout_ms: value.connect_timeout_ms.map(|v| v as u64),
      read_timeout_ms: value.read_timeout_ms.map(|v| v as u64),
      write_timeout_ms: value.write_timeout_ms.map(|v| v as u64),
      idle_timeout_ms: value.idle_timeout_ms.map(|v| v as u64),
      verify_cert: value.verify_cert,
      client_cert_pem: value.client_cert_pem,
      client_key_pem: value.client_key_pem,
      ca_cert_pem: value.ca_cert_pem,
    })
  }
}
