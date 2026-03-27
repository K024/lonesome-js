use napi_derive::napi;

use crate::config::{
  LoadBalancerAlgorithm, LoadBalancerConfig, UpstreamAddressConfig, UpstreamConfig,
};

#[napi(object)]
pub struct NapiLoadBalancerConfig {
  pub algorithm: Option<String>,
  pub max_iterations: Option<u32>,
  pub hash_key_rule: Option<String>,
}

#[napi(object)]
pub struct NapiUpstreamConfig {
  pub kind: Option<String>,
  pub address: String,
  pub tls: Option<bool>,
  pub sni: Option<String>,
  pub weight: Option<u32>,
}

impl TryFrom<NapiLoadBalancerConfig> for LoadBalancerConfig {
  type Error = String;

  fn try_from(value: NapiLoadBalancerConfig) -> Result<Self, Self::Error> {
    let algorithm = match value.algorithm.as_deref().unwrap_or("round_robin") {
      "round_robin" | "rr" => LoadBalancerAlgorithm::RoundRobin,
      "consistent_hash" | "consistent" | "ch" => LoadBalancerAlgorithm::ConsistentHash,
      other => return Err(format!("unsupported lb.algorithm '{other}'")),
    };

    Ok(LoadBalancerConfig {
      algorithm,
      max_iterations: value.max_iterations.unwrap_or(256) as usize,
      hash_key_rule: value.hash_key_rule.filter(|s| !s.trim().is_empty()),
    })
  }
}

impl TryFrom<NapiUpstreamConfig> for UpstreamConfig {
  type Error = String;

  fn try_from(value: NapiUpstreamConfig) -> Result<Self, Self::Error> {
    let address = match value.kind.as_deref().unwrap_or("tcp") {
      "tcp" => UpstreamAddressConfig::Tcp(value.address),
      #[cfg(unix)]
      "unix" => UpstreamAddressConfig::Unix(value.address),
      other => return Err(format!("unsupported upstream kind '{other}'")),
    };

    Ok(UpstreamConfig {
      address,
      tls: value.tls.unwrap_or(false),
      sni: value.sni,
      weight: value.weight.unwrap_or(1),
    })
  }
}
