use std::sync::Arc;

use arc_swap::ArcSwapOption;
use dashmap::DashMap;
use openssl::nid::Nid;
use openssl::pkey::PKey;
use openssl::x509::X509;

/// Parsed certificate material used to answer a TLS handshake.
pub struct CertEntry {
  /// Leaf certificate followed by intermediates (from the PEM stack).
  pub chain: Vec<X509>,
  pub key: PKey<openssl::pkey::Private>,
}

/// Per-SNI certificate store for downstream TLS listeners.
///
/// Lookup order: exact host -> most specific wildcard -> global default
/// (`host == '*'`) -> `None` (the listener's static cert from `start` config
/// remains the ultimate default until a `'*'` cert replaces it).
pub struct CertStore {
  default: ArcSwapOption<CertEntry>,
  exact: DashMap<String, Arc<CertEntry>>,
  /// Keyed by the domain without the `*.` prefix (lowercased).
  wildcard: DashMap<String, Arc<CertEntry>>,
}

impl Default for CertStore {
  fn default() -> Self {
    Self::new()
  }
}

impl CertStore {
  pub fn new() -> Self {
    Self {
      default: ArcSwapOption::const_empty(),
      exact: DashMap::new(),
      wildcard: DashMap::new(),
    }
  }

  /// Register or replace the certificate for `host`.
  ///
  /// - `'*'` replaces the global default certificate.
  /// - `'example.com'` is an exact hostname.
  /// - `'*.example.com'` is a one-label wildcard.
  ///
  /// Unless `allow_mismatch` is set, the certificate's SAN/CN must match
  /// `host` (exact hostname, or `*.domain` for a wildcard host).
  pub fn set(
    &self,
    host: &str,
    cert_pem: &str,
    key_pem: &str,
    allow_mismatch: bool,
  ) -> Result<(), String> {
    let entry = parse_cert_entry(cert_pem, key_pem)?;

    if host == "*" {
      self.default.store(Some(Arc::new(entry)));
      return Ok(());
    }

    if !allow_mismatch {
      verify_cert_matches(&entry.chain[0], host)?;
    }

    if let Some(domain) = host.strip_prefix("*.") {
      if domain.is_empty() || domain.contains('*') {
        return Err(format!("invalid wildcard cert host '{host}'"));
      }
      self.wildcard.insert(domain.to_lowercase(), Arc::new(entry));
    } else {
      self.exact.insert(host.to_lowercase(), Arc::new(entry));
    }
    Ok(())
  }

  /// Whether a global default cert (`updateCert('*')`) is set. Used to allow
  /// TLS listeners without a static cert at `start()`.
  pub fn has_default(&self) -> bool {
    self.default.load_full().is_some()
  }

  pub fn remove(&self, host: &str) -> bool {
    if host == "*" {
      let was_some = self.default.load_full().is_some();
      self.default.store(None);
      return was_some;
    }
    if let Some(domain) = host.strip_prefix("*.") {
      self.wildcard.remove(&domain.to_lowercase()).is_some()
    } else {
      self.exact.remove(&host.to_lowercase()).is_some()
    }
  }

  /// Resolve the certificate for a hostname: exact, then the one-label
  /// wildcard of the immediate parent domain, then the global default (`*`),
  /// then `None` so the acceptor's static cert is used.
  ///
  /// A wildcard matches exactly one label: `*.example.com` covers
  /// `www.example.com` but not `a.b.example.com` (which needs an explicit
  /// `*.b.example.com` wildcard or an exact cert).
  pub fn lookup(&self, host: &str) -> Option<Arc<CertEntry>> {
    let host = host.to_lowercase();
    if let Some(entry) = self.exact.get(&host) {
      return Some(entry.clone());
    }

    if let Some((_, parent)) = host.split_once('.') {
      if let Some(entry) = self.wildcard.get(parent) {
        return Some(entry.clone());
      }
    }

    self.default.load_full()
  }
}

fn parse_cert_entry(cert_pem: &str, key_pem: &str) -> Result<CertEntry, String> {
  let chain =
    X509::stack_from_pem(cert_pem.as_bytes()).map_err(|e| format!("invalid cert_pem: {e}"))?;
  if chain.is_empty() {
    return Err("cert_pem contains no certificates".to_string());
  }
  let key =
    PKey::private_key_from_pem(key_pem.as_bytes()).map_err(|e| format!("invalid key_pem: {e}"))?;
  Ok(CertEntry { chain, key })
}

/// SAN DNS names of the leaf cert, or its CN when no SAN is present.
fn cert_names(leaf: &X509) -> Vec<String> {
  let mut names = Vec::new();
  if let Some(sans) = leaf.subject_alt_names() {
    for name in sans.iter() {
      if let Some(dns) = name.dnsname() {
        names.push(dns.to_string());
      }
    }
    if !names.is_empty() {
      return names;
    }
  }
  for entry in leaf.subject_name().entries_by_nid(Nid::COMMONNAME) {
    if let Ok(value) = entry.data().as_utf8() {
      names.push(value.to_string());
    }
  }
  names
}

fn verify_cert_matches(leaf: &X509, host: &str) -> Result<(), String> {
  let names = cert_names(leaf);
  let matched = if let Some(domain) = host.strip_prefix("*.") {
    let wild = format!("*.{domain}");
    names.iter().any(|n| n.eq_ignore_ascii_case(&wild))
  } else {
    names.iter().any(|n| n.eq_ignore_ascii_case(host))
  };
  if matched {
    Ok(())
  } else {
    Err(format!(
      "certificate does not match host '{host}' (cert names: {})",
      names.join(", ")
    ))
  }
}
