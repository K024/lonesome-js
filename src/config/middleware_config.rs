#[derive(Clone, Debug)]
pub struct MiddlewareConfig {
  pub r#type: crate::middlewares::MiddlewareType,
}

impl MiddlewareConfig {
  pub fn validate(&self) -> Result<(), String> {
    match &self.r#type {
      crate::middlewares::MiddlewareType::AddHeader(cfg) => cfg.validate(),
      crate::middlewares::MiddlewareType::RemoveHeader(cfg) => cfg.validate(),
    }
  }
}
