use napi::bindgen_prelude::{Buffer, Function, Result};
use napi_derive::napi;

use crate::virtual_js::{
  register_virtual_listener as register_listener_impl,
  unregister_virtual_listener as unregister_listener_impl, virtual_push_event as push_event_impl,
};

fn napi_err(msg: impl Into<String>) -> napi::Error {
  napi::Error::from_reason(msg.into())
}

#[napi]
pub fn register_virtual_listener(
  key: String,
  on_event: Function<'_, (String, String, Buffer), ()>,
) -> Result<()> {
  register_listener_impl(key, on_event).map_err(napi_err)
}

#[napi]
pub fn unregister_virtual_listener(key: String) -> Result<bool> {
  unregister_listener_impl(key).map_err(napi_err)
}

#[napi]
pub fn virtual_push_event(
  kind: String,
  conn_id: String,
  data: Option<Buffer>,
  message: Option<String>,
) -> Result<()> {
  push_event_impl(kind, conn_id, data, message).map_err(napi_err)
}
