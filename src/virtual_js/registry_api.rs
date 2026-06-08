use napi::bindgen_prelude::{Buffer, Function};
use napi::threadsafe_function::ThreadsafeCallContext;

use super::registry_store::{detach_socket, registry};
use super::registry_types::ListenerEventCall;

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
      state.push_data(&conn_id, payload.to_vec())
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
