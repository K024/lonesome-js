use std::sync::mpsc;
use std::sync::Mutex;
use std::thread::{self, JoinHandle};

use async_trait::async_trait;
use pingora::listeners::tls::TlsSettings;
use pingora::proxy::http_proxy_service;
use pingora::server::configuration::ServerConf;
use pingora::server::{RunArgs, Server, ShutdownSignal, ShutdownSignalWatch};

use crate::config::{StartupConfig, StartupListenerConfig};
use crate::proxy::DenaliProxy;
use crate::route::SharedRouteTable;

pub struct DenaliRuntime {
  shutdown_tx: Option<mpsc::Sender<ShutdownSignal>>,
  handle: Option<JoinHandle<()>>,
}

impl DenaliRuntime {
  pub fn start(startup: StartupConfig, routes: SharedRouteTable) -> Result<Self, String> {
    startup.validate()?;

    let (shutdown_tx, shutdown_rx) = mpsc::channel::<ShutdownSignal>();

    let handle = thread::Builder::new()
      .name("denali-pingora".to_string())
      .spawn(move || {
        let mut conf = ServerConf::new().expect("default pingora conf");
        conf.grace_period_seconds = Some(0);
        conf.graceful_shutdown_timeout_seconds = Some(1);

        let mut server = Server::new_with_opt_and_conf(None, conf);
        server.bootstrap();

        let mut service = http_proxy_service(&server.configuration, DenaliProxy::new(routes));

        for listener in startup.listeners {
          match listener {
            StartupListenerConfig::Tcp { addr } => service.add_tcp(&addr),
            StartupListenerConfig::Tls {
              addr,
              cert_path,
              key_path,
            } => {
              let mut tls = TlsSettings::intermediate(cert_path.as_str(), key_path.as_str())
                .expect("build tls settings");
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
    })
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
}

impl Drop for DenaliRuntime {
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
    let rx = self
      .rx
      .lock()
      .expect("shutdown receiver mutex poisoned");
    rx.recv().unwrap_or(ShutdownSignal::GracefulTerminate)
  }
}
