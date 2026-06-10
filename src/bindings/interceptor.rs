use napi::bindgen_prelude::{Function, Promise, Result};
use napi_derive::napi;

use crate::bindings::error::to_napi_error;
use crate::interceptor::types::InterceptorRequest;
use crate::interceptor::{
  register_interceptor as register_interceptor_impl,
  unregister_interceptor as unregister_interceptor_impl,
};

#[napi]
pub fn register_interceptor(
  key: String,
  #[napi(
    ts_arg_type = "(request: { key: string, method: string, path: string }) => Promise<void | undefined | null | { action?: 'continue' } | { action: 'respond', status?: number, body?: string, contentType?: string }>"
  )]
  interceptor: Function<'_, (InterceptorRequest,), Promise<Option<serde_json::Value>>>,
) -> Result<()> {
  register_interceptor_impl(key, interceptor).map_err(to_napi_error)
}

#[napi]
pub fn unregister_interceptor(key: String) -> Result<bool> {
  unregister_interceptor_impl(key).map_err(to_napi_error)
}
