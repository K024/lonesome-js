pub use super::registry_api::{
  push_event, register_virtual_interceptor, register_virtual_listener,
  unregister_virtual_interceptor, unregister_virtual_listener,
};
pub use super::registry_connect::virtual_open_connection;

use super::registry_store::{detach_socket, registry, tsfn_closed};
use super::registry_types::{Listener, ListenerEventCall};
use crate::virtual_js::socket::VirtualJsSink;

impl VirtualJsSink for Listener {
  fn on_write(&self, conn_id: &str, data: &[u8]) -> Result<(), String> {
    let status = self.on_event.call(
      ListenerEventCall {
        kind: "write".to_string(),
        conn_id: conn_id.to_string(),
        data: data.to_vec().into(),
      },
      napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
    );

    if status != napi::Status::Ok {
      if tsfn_closed(status) {
        let _ = registry().unregister_listener(&self.key);
        detach_socket(conn_id);
      }
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
      napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
    );

    if status != napi::Status::Ok {
      if tsfn_closed(status) {
        let _ = registry().unregister_listener(&self.key);
        detach_socket(conn_id);
        return Ok(());
      }
      return Err(format!(
        "virtual listener '{}' on_close failed for conn '{}': {status:?}",
        self.key, conn_id
      ));
    }

    detach_socket(conn_id);
    Ok(())
  }
}
