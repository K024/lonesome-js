#[derive(Clone, Debug)]
pub enum UpstreamAddressConfig {
  Tcp(String),
  #[cfg(unix)]
  Unix(String),
  VirtualJs(String),
}

#[derive(Clone, Debug)]
pub struct UpstreamConfig {
  pub address: UpstreamAddressConfig,
  pub tls: bool,
  pub h2c: Option<bool>,
  pub sni: Option<String>,
  pub weight: u32,
  /// Milliseconds to wait for a TCP/TLS connection to the upstream.
  /// `None` means the underlying default (no explicit timeout) is used.
  pub connect_timeout_ms: Option<u64>,
  /// Milliseconds to wait for data from the upstream.
  /// `None` means no explicit read timeout.
  pub read_timeout_ms: Option<u64>,
  /// Milliseconds to wait for the upstream to accept written data.
  /// `None` means no explicit write timeout.
  pub write_timeout_ms: Option<u64>,
  /// Idle timeout for pooled upstream connections, in milliseconds.
  /// `None` means no explicit idle timeout.
  pub idle_timeout_ms: Option<u64>,
  /// Whether to verify the upstream TLS certificate. Defaults to `true`.
  pub verify_cert: Option<bool>,
  /// PEM-encoded client certificate presented to the upstream (mTLS).
  /// Must be provided together with `client_key_pem`.
  pub client_cert_pem: Option<String>,
  /// PEM-encoded private key for `client_cert_pem` (mTLS).
  pub client_key_pem: Option<String>,
  /// PEM-encoded CA bundle used to verify the upstream certificate.
  pub ca_cert_pem: Option<String>,
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
      UpstreamAddressConfig::VirtualJs(key) => {
        if key.trim().is_empty() {
          return Err("upstream virtual_js key cannot be empty".to_string());
        }
      }
    }

    if self.weight == 0 {
      return Err("upstream weight must be >= 1".to_string());
    }

    for (name, ms) in [
      ("connect_timeout_ms", self.connect_timeout_ms),
      ("read_timeout_ms", self.read_timeout_ms),
      ("write_timeout_ms", self.write_timeout_ms),
      ("idle_timeout_ms", self.idle_timeout_ms),
    ] {
      if let Some(0) = ms {
        return Err(format!("upstream {name} must be > 0"));
      }
    }

    match (&self.client_cert_pem, &self.client_key_pem) {
      (Some(_), Some(_)) => {}
      (None, None) => {}
      _ => {
        return Err(
          "upstream client_cert_pem and client_key_pem must be provided together".to_string(),
        );
      }
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
      max_iterations: 32,
      hash_key_rule: None,
    }
  }
}
