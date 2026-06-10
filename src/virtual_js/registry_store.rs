use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use arc_swap::ArcSwap;
use dashmap::DashMap;
use pingora::ErrorType;

use crate::virtual_js::socket::VirtualJsSocketState;

use super::registry_types::{ConnectContext, Listener, ListenerTsfn};

type ListenerMap = HashMap<String, Arc<Listener>>;

pub struct Registry {
  listeners: ArcSwap<ListenerMap>,
  listener_write_lock: Mutex<()>,
  sockets: DashMap<String, Arc<VirtualJsSocketState>>,
  seq: AtomicU64,
}

impl Default for Registry {
  fn default() -> Self {
    Self {
      listeners: ArcSwap::from_pointee(HashMap::new()),
      listener_write_lock: Mutex::new(()),
      sockets: DashMap::new(),
      seq: AtomicU64::new(0),
    }
  }
}

impl Registry {
  pub fn register_listener(&self, key: String, on_event: ListenerTsfn) -> Result<(), String> {
    let _guard = self
      .listener_write_lock
      .lock()
      .map_err(|_| "virtual listeners write lock poisoned".to_string())?;

    let current = self.listeners.load_full();
    if current.contains_key(&key) {
      return Err(format!("virtual listener '{key}' already exists"));
    }

    let mut next = (*current).clone();
    next.insert(key.clone(), Arc::new(Listener { key, on_event }));
    self.listeners.store(Arc::new(next));
    Ok(())
  }

  pub fn unregister_listener(&self, key: &str) -> Result<bool, String> {
    let _guard = self
      .listener_write_lock
      .lock()
      .map_err(|_| "virtual listeners write lock poisoned".to_string())?;

    let current = self.listeners.load_full();
    if !current.contains_key(key) {
      return Ok(false);
    }

    let mut next = (*current).clone();
    let removed = next.remove(key).is_some();
    self.listeners.store(Arc::new(next));
    Ok(removed)
  }

  pub fn init_connect(&self, key: &str) -> pingora::Result<ConnectContext> {
    let conn_id = self.next_conn_id(key);

    self
      .attach_socket_state(conn_id.clone(), VirtualJsSocketState::new())
      .map_err(|_| pingora::Error::new(ErrorType::InternalError))?;

    Ok(ConnectContext { conn_id })
  }

  pub fn listener(&self, key: &str) -> pingora::Result<Arc<Listener>> {
    self
      .listeners
      .load()
      .get(key)
      .cloned()
      .ok_or_else(|| pingora::Error::new(ErrorType::ConnectError))
  }

  pub fn socket_state(&self, conn_id: &str) -> Result<Option<Arc<VirtualJsSocketState>>, String> {
    Ok(
      self
        .sockets
        .get(conn_id)
        .map(|entry| Arc::clone(entry.value())),
    )
  }

  pub fn detach_socket_state(&self, conn_id: &str) -> Result<(), String> {
    self.sockets.remove(conn_id);
    Ok(())
  }

  fn next_conn_id(&self, key: &str) -> String {
    let n = self.seq.fetch_add(1, Ordering::Relaxed);
    format!("{key}:conn:{n}")
  }

  fn attach_socket_state(
    &self,
    conn_id: String,
    state: Arc<VirtualJsSocketState>,
  ) -> Result<(), String> {
    self.sockets.insert(conn_id, state);
    Ok(())
  }
}

pub fn registry() -> &'static Registry {
  static REGISTRY: OnceLock<Registry> = OnceLock::new();
  REGISTRY.get_or_init(Registry::default)
}

pub fn detach_socket(conn_id: &str) {
  let _ = registry().detach_socket_state(conn_id);
}

pub fn tsfn_closed(status: napi::Status) -> bool {
  status == napi::Status::Closing || status == napi::Status::Cancelled
}
