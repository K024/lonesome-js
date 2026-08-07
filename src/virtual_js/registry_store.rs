use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use arc_swap::ArcSwap;
use dashmap::DashMap;
use pingora::ErrorType;

use crate::virtual_js::socket::VirtualJsSocketState;

use super::registry_types::{ConnectContext, Listener, ListenerTsfn};

type ListenerMap = HashMap<String, Arc<Listener>>;

struct SocketEntry {
  state: Arc<VirtualJsSocketState>,
  listener: Arc<Listener>,
}

pub struct Registry {
  listeners: ArcSwap<ListenerMap>,
  listener_write_lock: Mutex<()>,
  sockets: DashMap<String, SocketEntry>,
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
    next.insert(key.clone(), Arc::new(Listener::new(key, on_event)));
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
    let Some(listener) = next.remove(key) else {
      return Ok(false);
    };
    self.listeners.store(Arc::new(next));
    drop(_guard);

    self.deactivate_listener(&listener);
    Ok(true)
  }

  pub fn init_connect(&self, listener: Arc<Listener>) -> pingora::Result<ConnectContext> {
    if !listener.is_active() {
      return Err(pingora::Error::new(ErrorType::ConnectError));
    }

    let conn_id = self.next_conn_id(&listener.key);
    let state = VirtualJsSocketState::new();
    listener
      .attach_connection(conn_id.clone(), &state)
      .map_err(|_| pingora::Error::new(ErrorType::ConnectError))?;

    self
      .attach_socket_state(conn_id.clone(), state, listener)
      .map_err(|_| pingora::Error::new(ErrorType::InternalError))?;

    if !self
      .sockets
      .get(&conn_id)
      .is_some_and(|entry| entry.listener.is_active())
    {
      let _ = self.detach_socket_state(&conn_id);
      return Err(pingora::Error::new(ErrorType::ConnectError));
    }

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
        .map(|entry| Arc::clone(&entry.value().state)),
    )
  }

  pub fn detach_socket_state(&self, conn_id: &str) -> Result<(), String> {
    if let Some((_, entry)) = self.sockets.remove(conn_id) {
      entry.listener.detach_connection(conn_id);
    }
    Ok(())
  }

  pub fn deactivate_listener_instance(&self, listener: &Arc<Listener>) {
    let _guard = match self.listener_write_lock.lock() {
      Ok(guard) => guard,
      Err(_) => return,
    };

    let current = self.listeners.load_full();
    if current
      .get(&listener.key)
      .is_some_and(|registered| Arc::ptr_eq(registered, listener))
    {
      let mut next = (*current).clone();
      next.remove(&listener.key);
      self.listeners.store(Arc::new(next));
    }
    drop(_guard);

    self.deactivate_listener(listener);
  }

  pub fn deactivate_socket_listener(&self, conn_id: &str) {
    let listener = self
      .sockets
      .get(conn_id)
      .map(|entry| Arc::clone(&entry.listener));

    if let Some(listener) = listener {
      self.deactivate_listener_instance(&listener);
    }
  }

  fn next_conn_id(&self, key: &str) -> String {
    let n = self.seq.fetch_add(1, Ordering::Relaxed);
    format!("{key}:conn:{n}")
  }

  fn attach_socket_state(
    &self,
    conn_id: String,
    state: Arc<VirtualJsSocketState>,
    listener: Arc<Listener>,
  ) -> Result<(), String> {
    self
      .sockets
      .insert(conn_id, SocketEntry { state, listener });
    Ok(())
  }

  fn deactivate_listener(&self, listener: &Arc<Listener>) {
    for (conn_id, state) in listener.deactivate() {
      listener.notify_close_best_effort(&conn_id);
      state.abort(format!(
        "virtual listener '{}' was unregistered",
        listener.key
      ));
      let _ = self.detach_socket_state(&conn_id);
    }
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
