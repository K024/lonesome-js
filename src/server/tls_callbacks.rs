use std::any::Any;
use std::sync::Arc;

use async_trait::async_trait;
use pingora::listeners::TlsAccept;
use pingora::tls::ssl::NameType;

#[derive(Clone, Debug)]
pub struct DownstreamTlsInfo {
  pub sni: Option<String>,
}

pub struct DownstreamTlsCallbacks;

#[async_trait]
impl TlsAccept for DownstreamTlsCallbacks {
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
