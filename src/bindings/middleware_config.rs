use napi_derive::napi;

use crate::config::MiddlewareConfig;
use crate::middlewares::{AddHeaderConfig, MiddlewareType, RemoveHeaderConfig};

#[napi(object)]
pub struct NapiMiddlewareConfig {
  pub r#type: String,
  pub name: Option<String>,
  pub value: Option<String>,
  pub cel: Option<String>,
}

impl TryFrom<NapiMiddlewareConfig> for MiddlewareConfig {
  type Error = String;

  fn try_from(value: NapiMiddlewareConfig) -> Result<Self, Self::Error> {
    let typed = match value.r#type.as_str() {
      "add_header" => {
        let name = value
          .name
          .ok_or_else(|| "middleware add_header.name is required".to_string())?;
        let header_value = value
          .value
          .ok_or_else(|| "middleware add_header.value is required".to_string())?;
        MiddlewareType::AddHeader(AddHeaderConfig {
          name,
          value: header_value,
          cel: value.cel,
        })
      }
      "remove_header" => {
        let name = value
          .name
          .ok_or_else(|| "middleware remove_header.name is required".to_string())?;
        MiddlewareType::RemoveHeader(RemoveHeaderConfig {
          name,
          cel: value.cel,
        })
      }
      other => return Err(format!("unsupported middleware type '{other}'")),
    };

    Ok(MiddlewareConfig { r#type: typed })
  }
}
