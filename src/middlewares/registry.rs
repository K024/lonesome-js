use crate::config::MiddlewareConfig;
use crate::middlewares::add_header::AddHeaderMiddleware;
use crate::middlewares::remove_header::RemoveHeaderMiddleware;
use crate::middlewares::{Middleware, MiddlewareType};

pub fn build_middleware(cfg: &MiddlewareConfig) -> Result<Box<dyn Middleware>, String> {
  match &cfg.r#type {
    MiddlewareType::AddHeader(v) => {
      Ok(Box::new(AddHeaderMiddleware::from_config(v.clone())?))
    }
    MiddlewareType::RemoveHeader(v) => {
      Ok(Box::new(RemoveHeaderMiddleware::from_config(v.clone())?))
    }
  }
}
