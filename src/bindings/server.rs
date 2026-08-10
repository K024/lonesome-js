use std::sync::Arc;
use std::sync::Mutex;

use napi::bindgen_prelude::Result;
use napi_derive::napi;

use crate::bindings::route_config::RouteConfig;
use crate::bindings::startup_config::StartupConfig;
use crate::bindings::status::ServerStatus;
use crate::bindings::{error::mutex_poisoned, error::to_napi_error};
use crate::config::{
  ListenerStatus, RouteConfig as CoreRouteConfig, RouteStatus as CoreRouteStatus,
  ServerStatus as CoreServerStatus, StartupListenerConfig,
};
use crate::route::{Route, SharedRouteTable};
use crate::server::cert_store::CertStore;
use crate::server::LonesomeRuntime;

#[napi(object)]
pub struct UpdateCertOptions {
  pub cert_pem: String,
  pub key_pem: String,
  pub allow_mismatch: Option<bool>,
}

#[napi]
pub struct LonesomeServer {
  routes: SharedRouteTable,
  runtime: Mutex<Option<LonesomeRuntime>>,
  cert_store: Arc<CertStore>,
}

fn build_route(route: RouteConfig) -> Result<Route> {
  let cfg: CoreRouteConfig = route.try_into().map_err(to_napi_error)?;
  Route::from_config(cfg).map_err(to_napi_error)
}

#[napi]
impl LonesomeServer {
  #[napi(constructor)]
  pub fn new() -> Self {
    Self {
      routes: SharedRouteTable::new(),
      runtime: Mutex::new(None),
      cert_store: Arc::new(CertStore::new()),
    }
  }

  #[napi]
  pub fn start(&self, startup: StartupConfig) -> Result<()> {
    let startup_cfg = startup.try_into().map_err(to_napi_error)?;

    let mut guard = self.runtime.lock().map_err(|_| mutex_poisoned("runtime"))?;
    if guard.is_some() {
      return Err(to_napi_error("lonesome server already started"));
    }

    let rt = LonesomeRuntime::start(startup_cfg, self.routes.clone(), self.cert_store.clone())
      .map_err(to_napi_error)?;
    *guard = Some(rt);
    Ok(())
  }

  /// Register or replace the TLS certificate served for `host`.
  ///
  /// - `'*'` replaces the global default certificate.
  /// - `'example.com'` is an exact hostname.
  /// - `'*.example.com'` is a one-label wildcard.
  ///
  /// Unless `options.allowMismatch` is set, the certificate's SAN/CN must
  /// match `host`. Takes effect on the next TLS handshake.
  #[napi]
  pub fn update_cert(&self, host: String, options: UpdateCertOptions) -> Result<()> {
    self
      .cert_store
      .set(
        &host,
        &options.cert_pem,
        &options.key_pem,
        options.allow_mismatch.unwrap_or(false),
      )
      .map_err(to_napi_error)
  }

  /// Remove a certificate previously registered via `setCert`.
  #[napi]
  pub fn remove_cert(&self, host: String) -> Result<bool> {
    Ok(self.cert_store.remove(&host))
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
  pub fn add_or_update(&self, route: RouteConfig) -> Result<()> {
    let route = build_route(route)?;
    self.routes.upsert_route(route);
    Ok(())
  }

  /// Validates and compiles a route configuration without adding or replacing a route.
  ///
  /// This follows the same conversion and construction path as `addOrUpdate`, including
  /// CEL compilation, middleware construction, and upstream/load-balancer validation.
  #[napi]
  pub fn validate(&self, route: RouteConfig) -> Result<()> {
    let _ = build_route(route)?;
    Ok(())
  }

  #[napi]
  pub fn remove(&self, route_id: String) -> Result<bool> {
    Ok(self.routes.remove_route(&route_id))
  }

  #[napi]
  pub fn status(&self) -> Result<ServerStatus> {
    let guard = self.runtime.lock().map_err(|_| mutex_poisoned("runtime"))?;
    let running = guard.as_ref().is_some_and(LonesomeRuntime::is_running);
    let route_count = self.routes.route_count() as u32;

    let (threads, work_stealing, listeners, sni_host_policy) = match guard.as_ref() {
      Some(rt) => {
        let startup = rt.startup();
        let listeners = startup
          .listeners
          .iter()
          .map(listener_status)
          .collect::<Vec<_>>();
        (
          startup.threads.unwrap_or(0) as u32,
          startup.work_stealing.unwrap_or(false),
          listeners,
          startup.sni_host_policy,
        )
      }
      None => (0, false, Vec::new(), Default::default()),
    };

    let routes = self
      .routes
      .read_snapshot()
      .routes()
      .map(|route| CoreRouteStatus {
        id: route.id.clone(),
        rule: route.rule().to_string(),
        priority: route.priority,
        load_balancer: route.load_balancer_status(),
        upstreams: route.upstream_status(),
      })
      .collect::<Vec<_>>();

    let core = CoreServerStatus {
      running,
      route_count: route_count as usize,
      threads: threads as usize,
      work_stealing,
      sni_host_policy,
      listeners,
      routes,
    };

    Ok(ServerStatus::from(core))
  }
}

fn listener_status(listener: &StartupListenerConfig) -> ListenerStatus {
  match listener {
    StartupListenerConfig::Tcp { addr } => ListenerStatus {
      kind: "tcp".to_string(),
      addr: addr.clone(),
    },
    StartupListenerConfig::Tls { addr, .. } => ListenerStatus {
      kind: "tls".to_string(),
      addr: addr.clone(),
    },
    #[cfg(unix)]
    StartupListenerConfig::Unix { path } => ListenerStatus {
      kind: "unix".to_string(),
      addr: path.clone(),
    },
  }
}
