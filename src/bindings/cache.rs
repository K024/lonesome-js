use napi::bindgen_prelude::Result;
use napi_derive::napi;

use crate::middlewares::cache::purge_route_cache_namespace;

fn napi_err(msg: impl Into<String>) -> napi::Error {
  napi::Error::from_reason(msg.into())
}

#[napi]
pub async fn purge_route_cache(route_id: String) -> Result<()> {
  purge_route_cache_namespace(&route_id)
    .await
    .map_err(napi_err)
}
