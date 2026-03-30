use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

use async_trait::async_trait;
use napi::bindgen_prelude::{Buffer, FnArgs, Function};
use napi::threadsafe_function::{
  ThreadsafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use pingora::connectors::L4Connect;
use pingora::protocols::l4::socket::SocketAddr;
use pingora::protocols::l4::stream::Stream;
use pingora::protocols::l4::virt::VirtualSocketStream;
use pingora::upstreams::peer::{HttpPeer, PeerOptions};
use pingora::ErrorType;

use super::socket::{VirtualJsSink, VirtualJsSocket, VirtualJsSocketState};

struct ListenerEventCall {
  kind: String,
  conn_id: String,
  data: Buffer,
}

struct Listener {
  key: String,
  on_event: ThreadsafeFunction<
    ListenerEventCall,
    (),
    FnArgs<(String, String, Buffer)>,
    napi::Status,
    false,
    false,
    8192,
  >,
}

impl VirtualJsSink for Listener {
  fn on_write(&self, conn_id: &str, data: &[u8]) -> Result<(), String> {
    let status = self.on_event.call(
      ListenerEventCall {
        kind: "write".to_string(),
        conn_id: conn_id.to_string(),
        data: data.to_vec().into(),
      },
      ThreadsafeFunctionCallMode::NonBlocking,
    );

    if status != napi::Status::Ok {
      return Err(format!(
        "virtual listener '{}' on_write failed for conn '{}': {status:?}",
        self.key, conn_id
      ));
    }

    Ok(())
  }

  fn on_close(&self, conn_id: &str) -> Result<(), String> {
    let status = self.on_event.call(
      ListenerEventCall {
        kind: "close".to_string(),
        conn_id: conn_id.to_string(),
        data: Vec::<u8>::new().into(),
      },
      ThreadsafeFunctionCallMode::NonBlocking,
    );

    if status != napi::Status::Ok {
      return Err(format!(
        "virtual listener '{}' on_close failed for conn '{}': {status:?}",
        self.key, conn_id
      ));
    }

    detach_socket(conn_id);
    Ok(())
  }
}

struct Registry {
  listeners: RwLock<HashMap<String, Arc<Listener>>>,
  sockets: RwLock<HashMap<String, Arc<VirtualJsSocketState>>>,
  seq: AtomicU64,
}

impl Default for Registry {
  fn default() -> Self {
    Self {
      listeners: RwLock::new(HashMap::new()),
      sockets: RwLock::new(HashMap::new()),
      seq: AtomicU64::new(0),
    }
  }
}

impl Registry {
  fn register_listener(
    &self,
    key: String,
    on_event: ThreadsafeFunction<
      ListenerEventCall,
      (),
      FnArgs<(String, String, Buffer)>,
      napi::Status,
      false,
      false,
      8192,
    >,
  ) -> Result<(), String> {
    let mut listeners = self
      .listeners
      .write()
      .map_err(|_| "virtual listeners rwlock poisoned".to_string())?;

    if listeners.contains_key(&key) {
      return Err(format!("virtual listener '{key}' already exists"));
    }

    let listener = Arc::new(Listener {
      key: key.clone(),
      on_event,
    });

    listeners.insert(key, listener);
    Ok(())
  }

  fn unregister_listener(&self, key: &str) -> Result<bool, String> {
    let mut listeners = self
      .listeners
      .write()
      .map_err(|_| "virtual listeners rwlock poisoned".to_string())?;
    Ok(listeners.remove(key).is_some())
  }

  fn listener(&self, key: &str) -> Result<Option<Arc<Listener>>, String> {
    let listeners = self
      .listeners
      .read()
      .map_err(|_| "virtual listeners rwlock poisoned".to_string())?;
    Ok(listeners.get(key).cloned())
  }

  fn next_conn_id(&self, key: &str) -> String {
    let n = self.seq.fetch_add(1, Ordering::Relaxed);
    format!("{key}:{n}")
  }

  fn attach_socket_state(
    &self,
    conn_id: String,
    state: Arc<VirtualJsSocketState>,
  ) -> Result<(), String> {
    let mut sockets = self
      .sockets
      .write()
      .map_err(|_| "virtual sockets rwlock poisoned".to_string())?;
    sockets.insert(conn_id, state);
    Ok(())
  }

  fn detach_socket_state(&self, conn_id: &str) -> Result<(), String> {
    let mut sockets = self
      .sockets
      .write()
      .map_err(|_| "virtual sockets rwlock poisoned".to_string())?;
    sockets.remove(conn_id);
    Ok(())
  }

  fn socket_state(&self, conn_id: &str) -> Result<Option<Arc<VirtualJsSocketState>>, String> {
    let sockets = self
      .sockets
      .read()
      .map_err(|_| "virtual sockets rwlock poisoned".to_string())?;
    Ok(sockets.get(conn_id).cloned())
  }
}

fn registry() -> &'static Registry {
  static REGISTRY: OnceLock<Registry> = OnceLock::new();
  REGISTRY.get_or_init(Registry::default)
}

fn detach_socket(conn_id: &str) {
  let _ = registry().detach_socket_state(conn_id);
}

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
    let (listener, conn_id, state) = {
      let listener = registry()
        .listener(&self.key)
        .map_err(|_| pingora::Error::new(ErrorType::InternalError))?
        .ok_or_else(|| pingora::Error::new(ErrorType::ConnectError))?;
      let conn_id = registry().next_conn_id(&self.key);
      let state = VirtualJsSocketState::new();
      registry()
        .attach_socket_state(conn_id.clone(), state.clone())
        .map_err(|_| pingora::Error::new(ErrorType::InternalError))?;
      (listener, conn_id, state)
    };

    if listener
      .on_event
      .call_async(ListenerEventCall {
        kind: "open".to_string(),
        conn_id: conn_id.clone(),
        data: Vec::<u8>::new().into(),
      })
      .await
      .is_err()
    {
      detach_socket(&conn_id);
      return Err(pingora::Error::new(ErrorType::ConnectError));
    }

    // Node handles Duplex creation and server.emit('connection', duplex) on open.
    let sink: Arc<dyn VirtualJsSink> = listener;
    let socket = VirtualJsSocket::new(conn_id, state, sink);
    Ok(Stream::from(VirtualSocketStream::new(Box::new(socket))))
  }
}

pub fn virtual_open_connection(key: &str, tls: bool, sni: String) -> Result<HttpPeer, String> {
  let listener_exists = registry()
    .listener(key)
    .map_err(|_| "virtual listeners rwlock poisoned".to_string())?
    .is_some();

  if !listener_exists {
    return Err(format!("virtual listener '{key}' not found"));
  }

  let mut peer = HttpPeer::new("127.0.0.1:1", tls, sni);
  let mut options = PeerOptions::new();
  options.custom_l4 = Some(Arc::new(VirtualJsConnector::new(key.to_string())));
  peer.options = options;
  Ok(peer)
}

pub fn register_virtual_listener(
  key: String,
  on_event: Function<'_, (String, String, Buffer), ()>,
) -> Result<(), String> {
  if key.trim().is_empty() {
    return Err("virtual listener key cannot be empty".to_string());
  }

  let on_event = on_event
    .build_threadsafe_function::<ListenerEventCall>()
    .max_queue_size::<8192>()
    .callee_handled::<false>()
    .build_callback(|ctx: ThreadsafeCallContext<ListenerEventCall>| {
      Ok((ctx.value.kind, ctx.value.conn_id, ctx.value.data).into())
    })
    .map_err(|e| format!("failed to build on_event tsfn: {e}"))?;

  registry().register_listener(key, on_event)
}

pub fn unregister_virtual_listener(key: String) -> Result<bool, String> {
  if key.trim().is_empty() {
    return Err("virtual listener key cannot be empty".to_string());
  }

  registry().unregister_listener(&key)
}

pub fn push_event(
  kind: String,
  conn_id: String,
  data: Option<Buffer>,
  message: Option<String>,
) -> Result<(), String> {
  match kind.as_str() {
    "data" => {
      let payload = data.ok_or_else(|| "virtual_push_event kind=data requires data".to_string())?;
      let state = registry()
        .socket_state(&conn_id)
        .map_err(|_| "virtual sockets rwlock poisoned".to_string())?
        .ok_or_else(|| format!("socket '{conn_id}' not found"))?;
      state.push_data(&conn_id, payload)
    }
    "eof" => {
      let state = registry()
        .socket_state(&conn_id)
        .map_err(|_| "virtual sockets rwlock poisoned".to_string())?
        .ok_or_else(|| format!("socket '{conn_id}' not found"))?;
      state.push_eof(&conn_id)?;
      detach_socket(&conn_id);
      Ok(())
    }
    "error" => {
      let msg =
        message.ok_or_else(|| "virtual_push_event kind=error requires message".to_string())?;
      let state = registry()
        .socket_state(&conn_id)
        .map_err(|_| "virtual sockets rwlock poisoned".to_string())?
        .ok_or_else(|| format!("socket '{conn_id}' not found"))?;
      state.push_error(&conn_id, msg)?;
      detach_socket(&conn_id);
      Ok(())
    }
    other => Err(format!("unsupported virtual_push_event kind '{other}'")),
  }
}
