use std::collections::HashMap;

use napi::bindgen_prelude::Either;
use napi_derive::napi;

use crate::server::error_page_store::ErrorPageConfig;

#[napi(object)]
pub struct ErrorPageOptions {
  pub id: String,
  /// Served error statuses: a single code, or a spec like `"400-403,418,500"`.
  /// Omit to serve any generated error status.
  #[napi(ts_type = "number | string")]
  pub status: Option<Either<u32, String>>,
  #[napi(ts_type = "string")]
  pub matcher: Option<String>,
  pub body: Option<String>,
  pub body_expression: Option<String>,
  pub content_type: Option<String>,
  #[napi(ts_type = "Record<string, string>")]
  pub headers: Option<HashMap<String, String>>,
  pub status_override: Option<u32>,
  pub priority: Option<i32>,
}

impl TryFrom<ErrorPageOptions> for ErrorPageConfig {
  type Error = String;

  fn try_from(value: ErrorPageOptions) -> Result<Self, Self::Error> {
    Ok(ErrorPageConfig {
      id: value.id,
      status: value.status.map(|s| match s {
        Either::A(code) => code.to_string(),
        Either::B(spec) => spec,
      }),
      matcher: value.matcher,
      body: value.body,
      body_expression: value.body_expression,
      content_type: value.content_type,
      headers: value.headers.unwrap_or_default().into_iter().collect(),
      status_override: value.status_override.map(|v| v as u16),
      priority: value.priority.unwrap_or(0),
    })
  }
}
