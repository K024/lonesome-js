use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use pingora::connectors::L4Connect;
use pingora::protocols::l4::socket::SocketAddr;
use pingora::protocols::l4::stream::Stream;
use pingora::protocols::l4::virt::VirtualSocketStream;
use pingora::upstreams::peer::{HttpPeer, PeerOptions};
use pingora::ErrorType;

use crate::virtual_js::socket::VirtualJsSocket;

use super::registry_store::{detach_socket, registry, tsfn_closed};
use super::registry_types::{Listener, ListenerEventCall};

#[derive(Clone)]
pub struct VirtualJsConnector {
  listener: Arc<Listener>,
}

impl fmt::Debug for VirtualJsConnector {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.debug_struct("VirtualJsConnector")
      .field("key", &self.listener.key)
      .finish()
  }
}

impl VirtualJsConnector {
  pub fn new(listener: Arc<Listener>) -> Self {
    Self { listener }
  }
}

#[async_trait]
impl L4Connect for VirtualJsConnector {
  async fn connect(&self, _addr: &SocketAddr) -> pingora::Result<Stream> {
    let listener = Arc::clone(&self.listener);
    let ctx = registry().init_connect(Arc::clone(&listener))?;

    if let Err(err) = listener
      .on_event
      .call_async(ListenerEventCall {
        kind: "open".to_string(),
        conn_id: ctx.conn_id.clone(),
        data: Vec::<u8>::new().into(),
      })
      .await
    {
      if tsfn_closed(err.status) {
        registry().deactivate_listener_instance(&listener);
      }
      detach_socket(&ctx.conn_id);
      return Err(pingora::Error::new(ErrorType::ConnectError));
    }

    if !listener.is_active() {
      detach_socket(&ctx.conn_id);
      return Err(pingora::Error::new(ErrorType::ConnectError));
    }

    // Node handles Duplex creation and server.emit('connection', duplex) on open.
    let state = registry()
      .socket_state(&ctx.conn_id)
      .map_err(|_| pingora::Error::new(ErrorType::InternalError))?
      .ok_or_else(|| pingora::Error::new(ErrorType::ConnectError))?;
    let socket = VirtualJsSocket::new(ctx.conn_id, state, listener);
    Ok(Stream::from(VirtualSocketStream::new(Box::new(socket))))
  }
}

pub fn virtual_open_connection(
  key: &str,
  dummy_addr: &SocketAddr,
  tls: bool,
  h2c: bool,
  sni: String,
) -> Result<HttpPeer, String> {
  let listener = registry()
    .listener(key)
    .map_err(|_| format!("virtual listener '{key}' is not registered"))?;
  let mut peer = HttpPeer::new(dummy_addr, tls, sni);
  let mut options = PeerOptions::new();
  if !tls && h2c {
    options.set_http_version(2, 2);
  }
  // Pingora virtual L4 streams do not have an OS fd/socket. In pingora-core 0.8.x,
  // Stream::id() returns -1 on Unix (INVALID_SOCKET on Windows) for virtual streams,
  // and the reusable-connection path still validates idle streams through
  // peer.matches_fd()/matches_sock() before test_reusable_stream(). That validation
  // cannot pass for virtual streams today (see cloudflare/pingora#883), so pooling
  // would only add failed reuse probes. Disable pooling explicitly until Pingora
  // exposes a virtual-stream-aware reuse check.
  options.idle_timeout = Some(std::time::Duration::from_secs(0));
  options.custom_l4 = Some(Arc::new(VirtualJsConnector::new(listener)));
  peer.options = options;
  Ok(peer)
}
