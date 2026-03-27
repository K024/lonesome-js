#[derive(Clone, Debug)]
pub enum UpstreamAddressConfig {
  Tcp(String),
  #[cfg(unix)]
  Unix(String),
}

#[derive(Clone, Debug)]
pub struct UpstreamConfig {
  pub address: UpstreamAddressConfig,
  pub tls: bool,
  pub sni: Option<String>,
  pub weight: u32,
}

impl UpstreamConfig {
  pub fn validate(&self) -> Result<(), String> {
    match &self.address {
      UpstreamAddressConfig::Tcp(addr) => {
        if addr.trim().is_empty() {
          return Err("upstream tcp address cannot be empty".to_string());
        }
      }
      #[cfg(unix)]
      UpstreamAddressConfig::Unix(path) => {
        if path.trim().is_empty() {
          return Err("upstream unix path cannot be empty".to_string());
        }
      }
    }

    if self.weight == 0 {
      return Err("upstream weight must be >= 1".to_string());
    }

    Ok(())
  }
}

#[derive(Clone, Debug)]
pub enum LoadBalancerAlgorithm {
  RoundRobin,
  ConsistentHash,
}

#[derive(Clone, Debug)]
pub struct LoadBalancerConfig {
  pub algorithm: LoadBalancerAlgorithm,
  pub max_iterations: usize,
  pub hash_key_rule: Option<String>,
}

impl Default for LoadBalancerConfig {
  fn default() -> Self {
    Self {
      algorithm: LoadBalancerAlgorithm::RoundRobin,
      max_iterations: 256,
      hash_key_rule: None,
    }
  }
}
