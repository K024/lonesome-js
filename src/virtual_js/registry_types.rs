use napi::bindgen_prelude::{Buffer, FnArgs};
use napi::threadsafe_function::ThreadsafeFunction;

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
}

pub struct ConnectContext {
  pub conn_id: String,
}
