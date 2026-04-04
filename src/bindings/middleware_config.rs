use napi_derive::napi;

use crate::config::{middleware_type_from_json, MiddlewareConfig as CoreMiddlewareConfig};

#[napi(object)]
pub struct MiddlewareConfig {
  pub r#type: String,
  pub config: serde_json::Value,
}

impl TryFrom<MiddlewareConfig> for CoreMiddlewareConfig {
  type Error = String;

  fn try_from(value: MiddlewareConfig) -> Result<Self, Self::Error> {
    let typed = middleware_type_from_json(value.r#type.as_str(), value.config)?;
    Ok(CoreMiddlewareConfig { r#type: typed })
  }
}
