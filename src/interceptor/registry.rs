use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use arc_swap::ArcSwap;
use napi::bindgen_prelude::{Function, Promise};
use napi::threadsafe_function::ThreadsafeCallContext;

use super::types::{Interceptor, InterceptorCall, InterceptorRequest, InterceptorTsfn};

type InterceptorMap = HashMap<String, Arc<Interceptor>>;

pub struct Registry {
  interceptors: ArcSwap<InterceptorMap>,
  write_lock: Mutex<()>,
}

impl Default for Registry {
  fn default() -> Self {
    Self {
      interceptors: ArcSwap::from_pointee(HashMap::new()),
      write_lock: Mutex::new(()),
    }
  }
}

impl Registry {
  pub fn register_interceptor(
    &self,
    key: String,
    on_intercept: InterceptorTsfn,
  ) -> Result<(), String> {
    let _guard = self
      .write_lock
      .lock()
      .map_err(|_| "interceptors write lock poisoned".to_string())?;

    let current = self.interceptors.load_full();
    if current.contains_key(&key) {
      return Err(format!("interceptor '{key}' already exists"));
    }

    let mut next = (*current).clone();
    next.insert(key.clone(), Arc::new(Interceptor { key, on_intercept }));
    self.interceptors.store(Arc::new(next));
    Ok(())
  }

  pub fn unregister_interceptor(&self, key: &str) -> Result<bool, String> {
    let _guard = self
      .write_lock
      .lock()
      .map_err(|_| "interceptors write lock poisoned".to_string())?;

    let current = self.interceptors.load_full();
    if !current.contains_key(key) {
      return Ok(false);
    }

    let mut next = (*current).clone();
    let removed = next.remove(key).is_some();
    self.interceptors.store(Arc::new(next));
    Ok(removed)
  }

  pub fn interceptor(&self, key: &str) -> pingora::Result<Option<Arc<Interceptor>>> {
    Ok(self.interceptors.load().get(key).cloned())
  }
}

pub fn registry() -> &'static Registry {
  static REGISTRY: OnceLock<Registry> = OnceLock::new();
  REGISTRY.get_or_init(Registry::default)
}

pub fn register_interceptor(
  key: String,
  interceptor: Function<'_, (InterceptorRequest,), Promise<Option<serde_json::Value>>>,
) -> Result<(), String> {
  if key.trim().is_empty() {
    return Err("interceptor key cannot be empty".to_string());
  }

  let on_intercept = interceptor
    .build_threadsafe_function::<InterceptorCall>()
    .max_queue_size::<8192>()
    .callee_handled::<false>()
    .build_callback(|ctx: ThreadsafeCallContext<InterceptorCall>| {
      Ok(
        (InterceptorRequest {
          key: ctx.value.key,
          method: ctx.value.method,
          path: ctx.value.path,
        },)
          .into(),
      )
    })
    .map_err(|e| format!("failed to build interceptor tsfn: {e}"))?;

  registry().register_interceptor(key, on_intercept)
}

pub fn unregister_interceptor(key: String) -> Result<bool, String> {
  if key.trim().is_empty() {
    return Err("interceptor key cannot be empty".to_string());
  }

  registry().unregister_interceptor(&key)
}

pub async fn run_interceptor(
  key: &str,
  method: String,
  path: String,
) -> pingora::Result<Option<serde_json::Value>> {
  let Some(interceptor) = registry().interceptor(key)? else {
    return Ok(None);
  };

  let intercept_promise = match interceptor
    .on_intercept
    .call_async(InterceptorCall {
      key: key.to_string(),
      method,
      path,
    })
    .await
  {
    Ok(promise) => promise,
    Err(err) => {
      if tsfn_closed(err.status) {
        let _ = registry().unregister_interceptor(&interceptor.key);
        return Ok(None);
      }
      return Err(pingora::Error::because(
        pingora::ErrorType::ConnectError,
        "interceptor call failed",
        std::io::Error::other(err.to_string()),
      ));
    }
  };

  intercept_promise.await.map_err(|err| {
    pingora::Error::because(
      pingora::ErrorType::ConnectError,
      "interceptor rejected",
      std::io::Error::other(err.to_string()),
    )
  })
}

fn tsfn_closed(status: napi::Status) -> bool {
  status == napi::Status::Closing || status == napi::Status::Cancelled
}
