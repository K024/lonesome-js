use napi_derive::napi;

use crate::config::{middleware_type_from_json, MiddlewareConfig};

#[napi(object)]
pub struct NapiMiddlewareConfig {
  pub r#type: String,
  pub config: serde_json::Value,
}

impl TryFrom<NapiMiddlewareConfig> for MiddlewareConfig {
  type Error = String;

  fn try_from(value: NapiMiddlewareConfig) -> Result<Self, Self::Error> {
    let typed = middleware_type_from_json(value.r#type.as_str(), value.config)?;
    Ok(MiddlewareConfig { r#type: typed })
  }
}
