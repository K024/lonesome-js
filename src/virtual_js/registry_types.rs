use std::sync::Arc;

use napi::bindgen_prelude::{Buffer, FnArgs, Promise};
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

pub type InterceptorTsfn = ThreadsafeFunction<
  InterceptorCall,
  Promise<()>,
  FnArgs<(String,)>,
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

pub struct InterceptorCall {
  pub conn_id: String,
}

pub struct Listener {
  pub key: String,
  pub on_event: ListenerTsfn,
}

pub struct Interceptor {
  pub path: String,
  pub on_intercept: InterceptorTsfn,
}

pub struct ConnectContext {
  pub interceptor: Option<Arc<Interceptor>>,
  pub conn_id: String,
}
