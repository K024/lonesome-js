use napi::bindgen_prelude::{FnArgs, Promise};
use napi::threadsafe_function::ThreadsafeFunction;

pub type InterceptorTsfn = ThreadsafeFunction<
  InterceptorCall,
  Promise<Option<serde_json::Value>>,
  FnArgs<(InterceptorRequest,)>,
  napi::Status,
  false,
  false,
  8192,
>;

pub struct InterceptorCall {
  pub key: String,
  pub method: String,
  pub path: String,
}

#[napi_derive::napi(object)]
pub struct InterceptorRequest {
  pub key: String,
  pub method: String,
  pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InterceptorAction {
  Continue,
  Respond,
}

#[derive(Debug, Clone)]
pub struct InterceptorResult {
  pub action: InterceptorAction,
  pub status: Option<u16>,
  pub body: Option<String>,
  pub content_type: Option<String>,
}

pub struct Interceptor {
  pub key: String,
  pub on_intercept: InterceptorTsfn,
}
