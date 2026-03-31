use napi::bindgen_prelude::Result;
use napi_derive::napi;

use crate::bindings::error::to_napi_error;
use crate::middlewares::cache::purge_route_cache_namespace;

#[napi]
pub async fn purge_route_cache(route_id: String) -> Result<()> {
  purge_route_cache_namespace(&route_id)
    .await
    .map_err(to_napi_error)
}
