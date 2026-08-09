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

#[cfg(test)]
mod tests {
  use super::*;
  use openssl::hash::MessageDigest;
  use openssl::pkey::PKey;
  use openssl::rsa::Rsa;
  use openssl::x509::extension::SubjectAlternativeName;
  use openssl::x509::{X509NameBuilder, X509};

  fn make_cert(sans: &[&str]) -> X509 {
    let key = PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap();

    let mut name_builder = X509NameBuilder::new().unwrap();
    name_builder.append_entry_by_text("CN", "test").unwrap();
    let name = name_builder.build();

    let mut builder = X509::builder().unwrap();
    builder.set_version(2).unwrap();
    builder.set_subject_name(&name).unwrap();
    builder.set_issuer_name(&name).unwrap();
    builder.set_pubkey(&key).unwrap();

    if !sans.is_empty() {
      let mut san = SubjectAlternativeName::new();
      for dns in sans {
        san.dns(dns);
      }
      let ext = san.build(&builder.x509v3_context(None, None)).unwrap();
      builder.append_extension(ext).unwrap();
    }

    builder.sign(&key, MessageDigest::sha256()).unwrap();
    builder.build()
  }

  fn make_cn_cert(cn: &str) -> X509 {
    let key = PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap();

    let mut name_builder = X509NameBuilder::new().unwrap();
    name_builder.append_entry_by_text("CN", cn).unwrap();
    let name = name_builder.build();

    let mut builder = X509::builder().unwrap();
    builder.set_version(2).unwrap();
    builder.set_subject_name(&name).unwrap();
    builder.set_issuer_name(&name).unwrap();
    builder.set_pubkey(&key).unwrap();
    builder.sign(&key, MessageDigest::sha256()).unwrap();
    builder.build()
  }

  #[test]
  fn exact_host_matches_any_san_entry() {
    let cert = make_cert(&["example.com", "www.example.com"]);
    assert!(verify_cert_matches(&cert, "example.com").is_ok());
    assert!(verify_cert_matches(&cert, "www.example.com").is_ok());
    assert!(verify_cert_matches(&cert, "other.com").is_err());
  }

  #[test]
  fn matching_is_case_insensitive() {
    let cert = make_cert(&["Example.COM"]);
    assert!(verify_cert_matches(&cert, "example.com").is_ok());
  }

  #[test]
  fn wildcard_host_requires_wildcard_san() {
    let wildcard = make_cert(&["*.example.com"]);
    assert!(verify_cert_matches(&wildcard, "*.example.com").is_ok());
    // An exact host does not satisfy a wildcard SAN, and vice versa.
    assert!(verify_cert_matches(&wildcard, "example.com").is_err());
    assert!(verify_cert_matches(&wildcard, "www.example.com").is_err());

    let exact = make_cert(&["example.com"]);
    assert!(verify_cert_matches(&exact, "*.example.com").is_err());
  }

  #[test]
  fn wildcard_host_multi_level_needs_the_same_depth_wildcard() {
    // `*.b.example.com` matches only a `*.b.example.com` SAN, not a shallower
    // `*.example.com` wildcard.
    let cert = make_cert(&["*.b.example.com"]);
    assert!(verify_cert_matches(&cert, "*.b.example.com").is_ok());
    assert!(verify_cert_matches(&cert, "*.example.com").is_err());
    assert!(verify_cert_matches(&cert, "*.a.b.example.com").is_err());
  }

  #[test]
  fn cn_is_used_when_no_san_present() {
    let cert = make_cn_cert("example.com");
    assert!(verify_cert_matches(&cert, "example.com").is_ok());
    assert!(verify_cert_matches(&cert, "other.com").is_err());
  }

  #[test]
  fn mismatch_error_reports_both_names() {
    let cert = make_cert(&["example.com"]);
    let err = verify_cert_matches(&cert, "other.com").unwrap_err();
    assert!(err.contains("other.com"), "err: {err}");
    assert!(err.contains("example.com"), "err: {err}");
  }

  fn make_cert_pem(sans: &[&str]) -> (String, String) {
    use openssl::asn1::Asn1Time;

    let key = PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap();

    let mut name_builder = X509NameBuilder::new().unwrap();
    name_builder.append_entry_by_text("CN", "test").unwrap();
    let name = name_builder.build();

    let mut builder = X509::builder().unwrap();
    builder.set_version(2).unwrap();
    builder.set_subject_name(&name).unwrap();
    builder.set_issuer_name(&name).unwrap();
    builder.set_pubkey(&key).unwrap();
    builder
      .set_not_before(&Asn1Time::days_from_now(0).unwrap())
      .unwrap();
    builder
      .set_not_after(&Asn1Time::days_from_now(365).unwrap())
      .unwrap();

    if !sans.is_empty() {
      let mut san = SubjectAlternativeName::new();
      for dns in sans {
        san.dns(dns);
      }
      let ext = san.build(&builder.x509v3_context(None, None)).unwrap();
      builder.append_extension(ext).unwrap();
    }

    builder.sign(&key, MessageDigest::sha256()).unwrap();
    let cert = builder.build();

    let cert_pem = String::from_utf8(cert.to_pem().unwrap()).unwrap();
    let key_pem = String::from_utf8(key.private_key_to_pem_pkcs8().unwrap()).unwrap();
    (cert_pem, key_pem)
  }

  fn set_cert(store: &CertStore, host: &str, sans: &[&str]) {
    let (cert_pem, key_pem) = make_cert_pem(sans);
    store
      .set(host, &cert_pem, &key_pem, false)
      .expect("set should succeed");
  }

  #[test]
  fn set_rejects_wildcard_host_with_wrong_wildcard_san() {
    let store = CertStore::new();
    let (cert_pem, key_pem) = make_cert_pem(&["*.example.com"]);
    let err = store
      .set("*.b.example.com", &cert_pem, &key_pem, false)
      .unwrap_err();
    assert!(err.contains("*.b.example.com"), "err: {err}");
  }

  #[test]
  fn lookup_one_label_wildcard_covers_immediate_parent_only() {
    let store = CertStore::new();
    set_cert(&store, "*.example.com", &["*.example.com"]);

    assert!(
      store.lookup("www.example.com").is_some(),
      "one label below the base matches"
    );
    assert!(store.lookup("api.example.com").is_some());
    assert!(
      store.lookup("example.com").is_none(),
      "the apex is not covered"
    );
    assert!(
      store.lookup("a.b.example.com").is_none(),
      "multi-level subdomains need a deeper wildcard or an exact cert"
    );
  }

  #[test]
  fn lookup_multi_level_uses_immediate_parent_wildcard() {
    let store = CertStore::new();
    set_cert(&store, "*.b.example.com", &["*.b.example.com"]);

    assert!(
      store.lookup("a.b.example.com").is_some(),
      "immediate parent wildcard covers it"
    );
    assert!(
      store.lookup("x.a.b.example.com").is_none(),
      "one more label requires *.a.b.example.com"
    );
  }

  #[test]
  fn lookup_exact_beats_wildcard() {
    let store = CertStore::new();
    set_cert(&store, "*.example.com", &["*.example.com"]);
    set_cert(&store, "www.example.com", &["www.example.com"]);

    let entry = store
      .lookup("www.example.com")
      .expect("resolves to the exact cert");
    let names = cert_names(&entry.chain[0]);
    assert_eq!(
      names,
      ["www.example.com".to_string()],
      "exact cert must win: {names:?}"
    );
  }

  #[test]
  fn lookup_falls_back_to_default_for_multi_level() {
    let store = CertStore::new();
    set_cert(&store, "*.example.com", &["*.example.com"]);
    set_cert(&store, "*", &["example.org"]);

    let entry = store
      .lookup("a.b.example.com")
      .expect("falls through to the default");
    let names = cert_names(&entry.chain[0]);
    assert_eq!(
      names,
      ["example.org".to_string()],
      "default cert used: {names:?}"
    );
  }

  #[test]
  fn lookup_is_case_insensitive() {
    let store = CertStore::new();
    set_cert(&store, "*.EXAMPLE.com", &["*.example.com"]);
    assert!(store.lookup("WWW.example.COM").is_some());
  }
}
