use std::sync::Mutex;

use napi::bindgen_prelude::Result;
use napi_derive::napi;

use crate::bindings::route_config::NapiRouteConfig;
use crate::bindings::startup_config::NapiStartupConfig;
use crate::bindings::status::NapiServerStatus;
use crate::bindings::{error::mutex_poisoned, error::to_napi_error};
use crate::config::RouteConfig;
use crate::route::{Route, SharedRouteTable};
use crate::server::LonesomeRuntime;

#[napi]
pub struct LonesomeServer {
  routes: SharedRouteTable,
  runtime: Mutex<Option<LonesomeRuntime>>,
}

#[napi]
impl LonesomeServer {
  #[napi(constructor)]
  pub fn new() -> Self {
    Self {
      routes: SharedRouteTable::new(),
      runtime: Mutex::new(None),
    }
  }

  #[napi]
  pub fn start(&self, startup: NapiStartupConfig) -> Result<()> {
    let startup_cfg = startup.try_into().map_err(to_napi_error)?;

    let mut guard = self.runtime.lock().map_err(|_| mutex_poisoned("runtime"))?;
    if guard.is_some() {
      return Err(to_napi_error("lonesome server already started"));
    }

    let rt = LonesomeRuntime::start(startup_cfg, self.routes.clone()).map_err(to_napi_error)?;
    *guard = Some(rt);
    Ok(())
  }

  #[napi]
  pub fn stop(&self) -> Result<()> {
    let mut guard = self.runtime.lock().map_err(|_| mutex_poisoned("runtime"))?;
    if let Some(rt) = guard.as_mut() {
      rt.stop().map_err(to_napi_error)?;
    }
    *guard = None;
    Ok(())
  }

  #[napi]
  pub fn add_or_update(&self, route: NapiRouteConfig) -> Result<()> {
    let cfg: RouteConfig = route.try_into().map_err(to_napi_error)?;
    let route = Route::from_config(cfg).map_err(to_napi_error)?;
    self.routes.upsert_route(route);
    Ok(())
  }

  #[napi]
  pub fn remove(&self, route_id: String) -> Result<bool> {
    Ok(self.routes.remove_route(&route_id))
  }

  #[napi]
  pub fn status(&self) -> Result<NapiServerStatus> {
    let guard = self.runtime.lock().map_err(|_| mutex_poisoned("runtime"))?;
    Ok(NapiServerStatus {
      running: guard.as_ref().is_some_and(LonesomeRuntime::is_running),
      route_count: self.routes.route_count() as u32,
    })
  }
}
