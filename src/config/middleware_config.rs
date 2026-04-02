use crate::middlewares::MiddlewareType;

#[derive(Clone, Debug)]
pub struct MiddlewareConfig {
  pub r#type: MiddlewareType,
}

impl MiddlewareConfig {
  pub fn validate(&self) -> Result<(), String> {
    match &self.r#type {
      MiddlewareType::RewriteMethod(cfg) => cfg.validate(),
      MiddlewareType::BasicAuth(cfg) => cfg.validate(),
      MiddlewareType::SetVariable(cfg) => cfg.validate(),
      MiddlewareType::RequestHeaders(cfg) => cfg.validate(),
      MiddlewareType::ResponseHeaders(cfg) => cfg.validate(),
      MiddlewareType::Compression(cfg) => cfg.validate(),
      MiddlewareType::HealthCheck(cfg) => cfg.validate(),
      MiddlewareType::Cache(cfg) => cfg.validate(),
      MiddlewareType::Rewrite(cfg) => cfg.validate(),
      MiddlewareType::Respond(cfg) => cfg.validate(),
      MiddlewareType::Redirect(cfg) => cfg.validate(),
      MiddlewareType::RedirectHttps(cfg) => cfg.validate(),
      MiddlewareType::RateLimit(cfg) => cfg.validate(),
      MiddlewareType::Cors(cfg) => cfg.validate(),
    }
  }
}

pub fn middleware_type_from_json(
  kind: &str,
  mut config_json: serde_json::Value,
) -> Result<MiddlewareType, String> {
  let obj = config_json
    .as_object_mut()
    .ok_or_else(|| format!("invalid middleware config json for '{kind}': expected JSON object"))?;

  obj.insert(
    "type".to_string(),
    serde_json::Value::String(kind.to_string()),
  );

  serde_json::from_value(config_json)
    .map_err(|e| format!("invalid middleware config payload for '{kind}': {e}"))
}
