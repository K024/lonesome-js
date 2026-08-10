use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use async_trait::async_trait;
use pingora::apps::HttpServerOptions;
use pingora::listeners::tls::TlsSettings;
use pingora::listeners::TlsAcceptCallbacks;
use pingora::proxy::http_proxy_service;
use pingora::server::configuration::ServerConf;
use pingora::server::{RunArgs, Server, ShutdownSignal, ShutdownSignalWatch};

use crate::config::{StartupConfig, StartupListenerConfig};
use crate::proxy::LonesomeProxy;
use crate::route::SharedRouteTable;
use crate::server::cert_store::CertStore;
use crate::server::error_page_store::ErrorPageStore;
use crate::server::tls_callbacks::DownstreamTlsCallbacks;

pub struct LonesomeRuntime {
  startup: StartupConfig,
  shutdown_tx: Option<mpsc::Sender<ShutdownSignal>>,
  handle: Option<JoinHandle<()>>,
}

impl LonesomeRuntime {
  pub fn start(
    startup: StartupConfig,
    routes: SharedRouteTable,
    cert_store: Arc<CertStore>,
    error_pages: Arc<ErrorPageStore>,
  ) -> Result<Self, String> {
    startup.validate()?;

    // A TLS listener without a static cert path is only allowed when a global
    // default cert has been set via updateCert('*').
    for listener in &startup.listeners {
      if let StartupListenerConfig::Tls { cert_path, .. } = listener {
        if cert_path.is_none() && !cert_store.has_default() {
          return Err(
            "tls listener requires certPath/keyPath unless updateCert('*') has set a global default cert"
              .to_string(),
          );
        }
      }
    }

    let (shutdown_tx, shutdown_rx) = mpsc::channel::<ShutdownSignal>();

    let startup_for_thread = startup.clone();
    let handle = thread::Builder::new()
      .name("lonesome-pingora".to_string())
      .spawn(move || {
        let mut conf = ServerConf::new().expect("default pingora conf");
        if let Some(threads) = startup_for_thread.threads {
          conf.threads = threads;
        }
        if let Some(work_stealing) = startup_for_thread.work_stealing {
          conf.work_stealing = work_stealing;
        }
        // No in-process background tasks, and callers typically drain upstream
        // load (via the JS controller) before calling stop(), so a short grace
        // window is enough. Both remain configurable in StartupConfig.
        conf.grace_period_seconds = Some(startup_for_thread.grace_period_seconds.unwrap_or(1));
        conf.graceful_shutdown_timeout_seconds =
          Some(startup_for_thread.graceful_shutdown_timeout_seconds.unwrap_or(1));
        if let Some(size) = startup_for_thread.upstream_keepalive_pool_size {
          conf.upstream_keepalive_pool_size = size;
        }
        if let Some(retries) = startup_for_thread.max_retries {
          conf.max_retries = retries;
        }

        let mut server = Server::new_with_opt_and_conf(None, conf);
        server.bootstrap();

        let mut service = http_proxy_service(
          &server.configuration,
          LonesomeProxy::new(
            routes,
            startup_for_thread.sni_host_policy,
            error_pages.clone(),
            startup_for_thread
              .downstream_read_timeout_ms
              .map(std::time::Duration::from_millis),
            startup_for_thread
              .downstream_write_timeout_ms
              .map(std::time::Duration::from_millis),
          ),
        );

        // Serve HTTP/2 prior-knowledge (h2c) on plaintext listeners.
        if startup_for_thread.enable_h2c_downstream.unwrap_or(false) {
          if let Some(app) = service.app_logic_mut() {
            let mut options = HttpServerOptions::default();
            options.h2c = true;
            app.server_options = Some(options);
          }
        }

        for listener in startup_for_thread.listeners {
          match listener {
            StartupListenerConfig::Tcp { addr } => service.add_tcp(&addr),
            StartupListenerConfig::Tls {
              addr,
              cert_path,
              key_path,
            } => {
              let callbacks: TlsAcceptCallbacks = Box::new(DownstreamTlsCallbacks {
                store: cert_store.clone(),
              });
              let mut tls =
                TlsSettings::with_callbacks(callbacks).expect("build tls settings with callbacks");
              if let (Some(cert_path), Some(key_path)) = (cert_path, key_path) {
                tls
                  .set_certificate_chain_file(cert_path.as_str())
                  .expect("set tls certificate chain");
                tls
                  .set_private_key_file(key_path.as_str(), pingora::tls::ssl::SslFiletype::PEM)
                  .expect("set tls private key");
              } else {
                // No static cert: handshakes are answered from the cert store;
                // LonesomeRuntime::start enforces a global default exists.
              }
              tls.enable_h2();
              service.add_tls_with_settings(&addr, None, tls);
            }
            #[cfg(unix)]
            StartupListenerConfig::Unix { path } => service.add_uds(&path, None),
          }
        }

        // TODO: implement cert store for in-memory TLS material management.

        server.add_service(service);

        let run_args = RunArgs {
          shutdown_signal: Box::new(ChannelShutdownSignalWatch::new(shutdown_rx)),
        };

        server.run(run_args);
      })
      .map_err(|e| format!("failed to spawn pingora thread: {e}"))?;

    Ok(Self {
      shutdown_tx: Some(shutdown_tx),
      handle: Some(handle),
      startup,
    })
  }

  /// Send the graceful shutdown signal and detach from the server thread,
  /// returning its join handle. The caller can join on a background thread so
  /// the calling (JS) thread is never blocked during graceful shutdown.
  pub fn detach_shutdown(mut self) -> Result<std::thread::JoinHandle<()>, String> {
    if let Some(tx) = self.shutdown_tx.take() {
      tx.send(ShutdownSignal::GracefulTerminate)
        .map_err(|e| format!("failed to send shutdown signal: {e}"))?;
    }
    Ok(self.handle.take().expect("runtime handle present"))
  }

  pub fn stop(&mut self) -> Result<(), String> {
    if let Some(tx) = self.shutdown_tx.take() {
      tx.send(ShutdownSignal::GracefulTerminate)
        .map_err(|e| format!("failed to send shutdown signal: {e}"))?;
    }

    if let Some(handle) = self.handle.take() {
      handle
        .join()
        .map_err(|_| "pingora thread panicked while joining".to_string())?;
    }

    Ok(())
  }

  pub fn is_running(&self) -> bool {
    self.handle.is_some()
  }

  pub fn startup(&self) -> &StartupConfig {
    &self.startup
  }
}

impl Drop for LonesomeRuntime {
  fn drop(&mut self) {
    let _ = self.stop();
  }
}

struct ChannelShutdownSignalWatch {
  rx: Mutex<mpsc::Receiver<ShutdownSignal>>,
}

impl ChannelShutdownSignalWatch {
  fn new(rx: mpsc::Receiver<ShutdownSignal>) -> Self {
    Self { rx: Mutex::new(rx) }
  }
}

#[async_trait]
impl ShutdownSignalWatch for ChannelShutdownSignalWatch {
  async fn recv(&self) -> ShutdownSignal {
    let rx = self.rx.lock().expect("shutdown receiver mutex poisoned");
    rx.recv().unwrap_or(ShutdownSignal::GracefulTerminate)
  }
}
