use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use napi::bindgen_prelude::{Buffer, FnArgs};
use napi::threadsafe_function::ThreadsafeFunction;

use crate::virtual_js::socket::VirtualJsSocketState;

pub type ListenerTsfn = ThreadsafeFunction<
  ListenerEventCall,
  (),
  FnArgs<(String, String, Buffer)>,
  napi::Status,
  false,
  false,
  8192,
>;

pub struct ListenerEventCall {
  pub kind: String,
  pub conn_id: String,
  pub data: Buffer,
}

pub struct Listener {
  pub key: String,
  pub on_event: ListenerTsfn,
  active: AtomicBool,
  connections: Mutex<HashMap<String, Weak<VirtualJsSocketState>>>,
}

impl Listener {
  pub fn new(key: String, on_event: ListenerTsfn) -> Self {
    Self {
      key,
      on_event,
      active: AtomicBool::new(true),
      connections: Mutex::new(HashMap::new()),
    }
  }

  pub fn is_active(&self) -> bool {
    self.active.load(Ordering::Acquire)
  }

  pub fn attach_connection(
    &self,
    conn_id: String,
    state: &Arc<VirtualJsSocketState>,
  ) -> Result<(), String> {
    let mut connections = self
      .connections
      .lock()
      .map_err(|_| "virtual listener connections lock poisoned".to_string())?;
    if !self.is_active() {
      return Err(format!("virtual listener '{}' is not active", self.key));
    }
    connections.insert(conn_id, Arc::downgrade(state));
    Ok(())
  }

  pub fn detach_connection(&self, conn_id: &str) {
    if let Ok(mut connections) = self.connections.lock() {
      connections.remove(conn_id);
    }
  }

  pub fn deactivate(&self) -> Vec<(String, Arc<VirtualJsSocketState>)> {
    self.active.store(false, Ordering::Release);

    let Ok(mut connections) = self.connections.lock() else {
      return Vec::new();
    };

    connections
      .drain()
      .filter_map(|(conn_id, state)| state.upgrade().map(|state| (conn_id, state)))
      .collect()
  }
}

pub struct ConnectContext {
  pub conn_id: String,
}
