use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

use pingora::ErrorType;

use crate::virtual_js::socket::VirtualJsSocketState;

use super::registry_types::{ConnectContext, Interceptor, InterceptorTsfn, Listener, ListenerTsfn};

pub struct Registry {
  listeners: RwLock<HashMap<String, Arc<Listener>>>,
  interceptors: RwLock<HashMap<String, Arc<Interceptor>>>,
  sockets: RwLock<HashMap<String, Arc<VirtualJsSocketState>>>,
  seq: AtomicU64,
}

impl Default for Registry {
  fn default() -> Self {
    Self {
      listeners: RwLock::new(HashMap::new()),
      interceptors: RwLock::new(HashMap::new()),
      sockets: RwLock::new(HashMap::new()),
      seq: AtomicU64::new(0),
    }
  }
}

impl Registry {
  pub fn register_listener(&self, key: String, on_event: ListenerTsfn) -> Result<(), String> {
    let mut listeners = self
      .listeners
      .write()
      .map_err(|_| "virtual listeners rwlock poisoned".to_string())?;

    if listeners.contains_key(&key) {
      return Err(format!("virtual listener '{key}' already exists"));
    }

    listeners.insert(key.clone(), Arc::new(Listener { key, on_event }));
    Ok(())
  }

  pub fn unregister_listener(&self, key: &str) -> Result<bool, String> {
    let mut listeners = self
      .listeners
      .write()
      .map_err(|_| "virtual listeners rwlock poisoned".to_string())?;
    Ok(listeners.remove(key).is_some())
  }

  pub fn register_interceptor(
    &self,
    path: String,
    on_intercept: InterceptorTsfn,
  ) -> Result<(), String> {
    let mut interceptors = self
      .interceptors
      .write()
      .map_err(|_| "virtual interceptors rwlock poisoned".to_string())?;

    if interceptors.contains_key(&path) {
      return Err(format!("virtual interceptor '{path}' already exists"));
    }

    interceptors.insert(path.clone(), Arc::new(Interceptor { path, on_intercept }));
    Ok(())
  }

  pub fn unregister_interceptor(&self, path: &str) -> Result<bool, String> {
    let mut interceptors = self
      .interceptors
      .write()
      .map_err(|_| "virtual interceptors rwlock poisoned".to_string())?;
    Ok(interceptors.remove(path).is_some())
  }

  pub fn init_connect(&self, key: &str) -> pingora::Result<ConnectContext> {
    let interceptor = self
      .interceptors
      .read()
      .map_err(|_| pingora::Error::new(ErrorType::InternalError))?
      .get(key)
      .cloned();

    let conn_id = self.next_conn_id(key);

    self
      .attach_socket_state(conn_id.clone(), VirtualJsSocketState::new())
      .map_err(|_| pingora::Error::new(ErrorType::InternalError))?;

    Ok(ConnectContext {
      interceptor,
      conn_id,
    })
  }

  pub fn listener(&self, key: &str) -> pingora::Result<Arc<Listener>> {
    self
      .listeners
      .read()
      .map_err(|_| pingora::Error::new(ErrorType::InternalError))?
      .get(key)
      .cloned()
      .ok_or_else(|| pingora::Error::new(ErrorType::ConnectError))
  }

  pub fn socket_state(&self, conn_id: &str) -> Result<Option<Arc<VirtualJsSocketState>>, String> {
    let sockets = self
      .sockets
      .read()
      .map_err(|_| "virtual sockets rwlock poisoned".to_string())?;
    Ok(sockets.get(conn_id).cloned())
  }

  pub fn detach_socket_state(&self, conn_id: &str) -> Result<(), String> {
    let mut sockets = self
      .sockets
      .write()
      .map_err(|_| "virtual sockets rwlock poisoned".to_string())?;
    sockets.remove(conn_id);
    Ok(())
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
