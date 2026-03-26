use napi_derive::napi;

#[napi(object)]
pub struct NapiServerStatus {
  pub running: bool,
  pub route_count: u32,
}
