use std::any::Any;
use std::sync::Arc;

use async_trait::async_trait;
use pingora::listeners::TlsAccept;
use pingora::tls::ssl::NameType;

use crate::server::cert_store::CertStore;

#[derive(Clone, Debug)]
pub struct DownstreamTlsInfo {
  pub sni: Option<String>,
}

pub struct DownstreamTlsCallbacks {
  pub store: Arc<CertStore>,
}

#[async_trait]
impl TlsAccept for DownstreamTlsCallbacks {
  async fn certificate_callback(&self, tls_ref: &mut pingora::protocols::tls::TlsRef) {
    let Some(sni) = tls_ref
      .servername(NameType::HOST_NAME)
      .map(ToOwned::to_owned)
    else {
      return;
    };

    let Some(entry) = self.store.lookup(&sni) else {
      return; // no override: the acceptor's static cert (the default) is used
    };

    if tls_ref.set_certificate(&entry.chain[0]).is_err() {
      return;
    }
    if tls_ref.set_private_key(&entry.key).is_err() {
      return;
    }
    for intermediate in &entry.chain[1..] {
      let _ = tls_ref.add_chain_cert(intermediate.clone());
    }
  }

  async fn handshake_complete_callback(
    &self,
    tls_ref: &pingora::protocols::tls::TlsRef,
  ) -> Option<Arc<dyn Any + Send + Sync>> {
    let sni = tls_ref
      .servername(NameType::HOST_NAME)
      .map(ToOwned::to_owned);
    Some(Arc::new(DownstreamTlsInfo { sni }))
  }
}
