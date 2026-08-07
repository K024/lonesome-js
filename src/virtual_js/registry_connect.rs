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
  options.custom_l4 = Some(Arc::new(VirtualJsConnector::new(listener)));
  peer.options = options;
  Ok(peer)
}
