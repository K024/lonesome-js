use std::sync::Mutex;

use napi::bindgen_prelude::Result;
use napi_derive::napi;

use crate::bindings::route_config::NapiRouteConfig;
use crate::bindings::startup_config::NapiStartupConfig;
use crate::bindings::status::NapiServerStatus;
use crate::config::RouteConfig;
use crate::route::{Route, SharedRouteTable};
use crate::server::DenaliRuntime;

fn napi_err(msg: impl Into<String>) -> napi::Error {
  napi::Error::from_reason(msg.into())
}

#[napi]
pub struct DenaliServer {
  routes: SharedRouteTable,
  runtime: Mutex<Option<DenaliRuntime>>,
}

#[napi]
impl DenaliServer {
  #[napi(constructor)]
  pub fn new() -> Self {
    Self {
      routes: SharedRouteTable::new(),
      runtime: Mutex::new(None),
    }
  }

  #[napi]
  pub fn start(&self, startup: NapiStartupConfig) -> Result<()> {
    let startup_cfg = startup.try_into().map_err(napi_err)?;

    let mut guard = self.runtime.lock().map_err(|_| napi_err("runtime mutex poisoned"))?;
    if guard.is_some() {
      return Err(napi_err("denali server already started"));
    }

    let rt = DenaliRuntime::start(startup_cfg, self.routes.clone()).map_err(napi_err)?;
    *guard = Some(rt);
    Ok(())
  }

  #[napi]
  pub fn stop(&self) -> Result<()> {
    let mut guard = self.runtime.lock().map_err(|_| napi_err("runtime mutex poisoned"))?;
    if let Some(rt) = guard.as_mut() {
      rt.stop().map_err(napi_err)?;
    }
    *guard = None;
    Ok(())
  }

  #[napi]
  pub fn add_or_update(&self, route: NapiRouteConfig) -> Result<()> {
    let cfg: RouteConfig = route.try_into().map_err(napi_err)?;
    let route = Route::from_config(cfg).map_err(napi_err)?;
    self.routes.upsert_route(route);
    Ok(())
  }

  #[napi]
  pub fn remove(&self, route_id: String) -> Result<bool> {
    Ok(self.routes.remove_route(&route_id))
  }

  #[napi]
  pub fn status(&self) -> Result<NapiServerStatus> {
    let guard = self.runtime.lock().map_err(|_| napi_err("runtime mutex poisoned"))?;
    Ok(NapiServerStatus {
      running: guard.as_ref().is_some_and(DenaliRuntime::is_running),
      route_count: self.routes.route_count() as u32,
    })
  }
}
