use napi_derive::napi;

#[napi(object)]
pub struct ServerStatus {
  pub running: bool,
  pub route_count: u32,
}
