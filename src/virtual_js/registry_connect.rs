use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use pingora::connectors::L4Connect;
use pingora::protocols::l4::socket::SocketAddr;
use pingora::protocols::l4::stream::Stream;
use pingora::protocols::l4::virt::VirtualSocketStream;
use pingora::upstreams::peer::{HttpPeer, PeerOptions};
use pingora::ErrorType;

use crate::virtual_js::socket::{VirtualJsSink, VirtualJsSocket};

use super::registry_store::{detach_socket, registry, tsfn_closed};
use super::registry_types::{InterceptorCall, ListenerEventCall};

#[derive(Clone)]
pub struct VirtualJsConnector {
  key: String,
}

impl fmt::Debug for VirtualJsConnector {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.debug_struct("VirtualJsConnector")
      .field("key", &self.key)
      .finish()
  }
}

impl VirtualJsConnector {
  pub fn new(key: String) -> Self {
    Self { key }
  }
}

#[async_trait]
impl L4Connect for VirtualJsConnector {
  async fn connect(&self, _addr: &SocketAddr) -> pingora::Result<Stream> {
    let ctx = registry().init_connect(&self.key)?;

    if let Some(interceptor) = ctx.interceptor {
      let intercept_promise = match interceptor
        .on_intercept
        .call_async(InterceptorCall {
          conn_id: ctx.conn_id.clone(),
        })
        .await
      {
        Ok(promise) => promise,
        Err(err) => {
          if tsfn_closed(err.status) {
            let _ = registry().unregister_interceptor(&interceptor.path);
          }
          detach_socket(&ctx.conn_id);
          return Err(pingora::Error::new(ErrorType::ConnectError));
        }
      };

      if intercept_promise.await.is_err() {
        detach_socket(&ctx.conn_id);
        return Err(pingora::Error::new(ErrorType::ConnectError));
      }
    }

    let listener = registry().listener(&self.key)?;

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
        let _ = registry().unregister_listener(&self.key);
      }
      detach_socket(&ctx.conn_id);
      return Err(pingora::Error::new(ErrorType::ConnectError));
    }

    // Node handles Duplex creation and server.emit('connection', duplex) on open.
    let sink: Arc<dyn VirtualJsSink> = listener;
    let state = registry()
      .socket_state(&ctx.conn_id)
      .map_err(|_| pingora::Error::new(ErrorType::InternalError))?
      .ok_or_else(|| pingora::Error::new(ErrorType::ConnectError))?;
    let socket = VirtualJsSocket::new(ctx.conn_id, state, sink);
    Ok(Stream::from(VirtualSocketStream::new(Box::new(socket))))
  }
}

pub fn virtual_open_connection(
  key: &str,
  dummy_addr: &SocketAddr,
  group_key: u64,
  tls: bool,
  h2c: bool,
  sni: String,
) -> Result<HttpPeer, String> {
  let mut peer = HttpPeer::new(dummy_addr, tls, sni);
  peer.group_key = group_key;
  let mut options = PeerOptions::new();
  if !tls && h2c {
    options.set_http_version(2, 2);
  }
  options.custom_l4 = Some(Arc::new(VirtualJsConnector::new(key.to_string())));
  peer.options = options;
  Ok(peer)
}
