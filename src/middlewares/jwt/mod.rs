mod algorithms;

use std::time::SystemTime;

use async_trait::async_trait;
use cel::{Program, Value};
use josekit::jwt;
use pingora::http::ResponseHeader;
use pingora::proxy::Session;
use pingora::Result;
use serde::Deserialize;
use serde_json::Value as JsonValue;

use crate::matcher::cel_session_context::{
  ensure_context, ensure_context_mut, ensure_session_cel_context,
};
use crate::middlewares::middleware::middleware_internal_error;
use crate::middlewares::Middleware;
use crate::proxy::ctx::ProxyCtx;

use self::algorithms::{read_alg_kid, JwksVerifierPool};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JwtErrorModeConfig {
  Deny,
  Passthrough,
}

#[derive(Clone, Debug, Deserialize)]
pub struct JwtConfig {
  #[serde(default = "default_header_name")]
  pub header_name: String,
  #[serde(default = "default_bearer_prefix")]
  pub bearer_prefix: String,

  pub jwks: String,

  #[serde(default)]
  pub validate_time: bool,

  #[serde(default = "default_error_mode")]
  pub on_error: JwtErrorModeConfig,
  pub rule: Option<String>,
}

fn default_header_name() -> String {
  "authorization".to_string()
}

fn default_bearer_prefix() -> String {
  "Bearer ".to_string()
}

fn default_error_mode() -> JwtErrorModeConfig {
  JwtErrorModeConfig::Deny
}

impl JwtConfig {
  pub fn validate(&self) -> Result<(), String> {
    if self.header_name.trim().is_empty() {
      return Err("middleware jwt.header_name cannot be empty".to_string());
    }

    if self.jwks.trim().is_empty() {
      return Err("middleware jwt.jwks cannot be empty".to_string());
    }

    Ok(())
  }
}

pub struct JwtMiddleware {
  header_name: String,
  bearer_prefix: String,
  on_error: JwtErrorModeConfig,
  validate_time: bool,
  jwks_pool: JwksVerifierPool,
  rule_program: Option<Program>,
}

impl JwtMiddleware {
  pub fn from_config(cfg: JwtConfig) -> Result<Self, String> {
    cfg.validate()?;

    let rule_program = if let Some(expr) = cfg.rule {
      Some(
        Program::compile(&expr).map_err(|e| format!("failed to compile jwt rule '{expr}': {e}"))?,
      )
    } else {
      None
    };

    Ok(Self {
      header_name: cfg.header_name,
      bearer_prefix: cfg.bearer_prefix,
      on_error: cfg.on_error,
      validate_time: cfg.validate_time,
      jwks_pool: JwksVerifierPool::from_jwks(cfg.jwks.as_str())?,
      rule_program,
    })
  }

  fn should_apply(&self, proxy_ctx: &mut ProxyCtx, session: &Session) -> bool {
    let Some(program) = &self.rule_program else {
      return true;
    };

    let ctx = ensure_context(session, proxy_ctx);
    matches!(program.execute(ctx), Ok(Value::Bool(true)))
  }

  fn extract_token(&self, session: &Session) -> Result<String, String> {
    let header_val = session
      .req_header()
      .headers
      .get(self.header_name.as_str())
      .and_then(|v| v.to_str().ok())
      .map(str::trim)
      .ok_or_else(|| format!("missing auth header: {}", self.header_name))?;

    if self.bearer_prefix.is_empty() {
      return Ok(header_val.to_string());
    }

    if !header_val.starts_with(self.bearer_prefix.as_str()) {
      return Err(format!(
        "invalid auth header prefix on {}",
        self.header_name
      ));
    }

    let token = header_val
      .strip_prefix(self.bearer_prefix.as_str())
      .map(str::trim)
      .unwrap_or_default();

    if token.is_empty() {
      return Err("empty jwt token".to_string());
    }

    Ok(token.to_string())
  }

  fn verify_or_decrypt_payload(&self, token: &str) -> Result<josekit::jwt::JwtPayload, String> {
    let part_count = token.split('.').count();

    let payload = match part_count {
      3 => self.decode_jwt(token)?,
      5 => self.decode_jwe(token)?,
      _ => {
        return Err(format!(
          "invalid token format: expected 3(JWT) or 5(JWE) segments, got {part_count}"
        ));
      }
    };

    if self.validate_time {
      self.validate_time_claims(&payload)?;
    }

    Ok(payload)
  }

  fn decode_jwt(&self, token: &str) -> Result<josekit::jwt::JwtPayload, String> {
    let (alg, kid) = read_alg_kid(token)?;

    let verifiers = self.jwks_pool.verifiers_for(alg.as_str(), kid.as_deref())?;

    for verifier in verifiers {
      if let Ok((payload, _header)) = jwt::decode_with_verifier(token, verifier.as_ref()) {
        return Ok(payload);
      }
    }

    Err("jwt verify failed".to_string())
  }

  fn decode_jwe(&self, token: &str) -> Result<josekit::jwt::JwtPayload, String> {
    let (alg, kid) = read_alg_kid(token)?;

    let decrypters = self
      .jwks_pool
      .decrypters_for(alg.as_str(), kid.as_deref())?;

    for decrypter in decrypters {
      if let Ok((payload, _header)) = jwt::decode_with_decrypter(token, decrypter.as_ref()) {
        return Ok(payload);
      }
    }

    Err("jwe decrypt failed".to_string())
  }

  fn validate_time_claims(&self, payload: &josekit::jwt::JwtPayload) -> Result<(), String> {
    let now = SystemTime::now();

    if let Some(nbf) = payload.not_before() {
      if nbf > now {
        return Err("jwt nbf is in the future".to_string());
      }
    }

    if let Some(exp) = payload.expires_at() {
      if exp <= now {
        return Err("jwt exp is expired".to_string());
      }
    }

    Ok(())
  }

  fn set_cel_claims(
    &self,
    proxy_ctx: &mut ProxyCtx,
    session: &Session,
    payload: josekit::jwt::JwtPayload,
  ) -> Result<()> {
    let cel = ensure_session_cel_context(session, proxy_ctx);
    cel.cel_http_session.set_jwt_payload(Some(payload.clone()));

    let claims_json = JsonValue::Object(payload.claims_set().clone());
    let cel_payload = cel::to_value(claims_json)
      .map_err(|e| middleware_internal_error("jwt payload to cel value failed", e.to_string()))?;

    let ctx = ensure_context_mut(session, proxy_ctx);
    ctx.add_variable_from_value("jwt_payload", cel_payload);
    Ok(())
  }

  async fn deny_unauthorized(&self, session: &mut Session) -> Result<bool> {
    let mut resp = ResponseHeader::build(401, Some(3))
      .map_err(|e| middleware_internal_error("jwt build 401 failed", e.to_string()))?;

    resp
      .insert_header("Content-Length", "0")
      .map_err(|e| middleware_internal_error("jwt insert content-length failed", e.to_string()))?;

    session
      .write_response_header(Box::new(resp), true)
      .await
      .map_err(|e| middleware_internal_error("jwt write 401 failed", e.to_string()))?;

    Ok(true)
  }
}

#[async_trait]
impl Middleware for JwtMiddleware {
  async fn request_filter(&self, proxy_ctx: &mut ProxyCtx, session: &mut Session) -> Result<bool> {
    if !self.should_apply(proxy_ctx, session) {
      return Ok(false);
    }

    let result = (|| -> Result<(), String> {
      let token = self.extract_token(session)?;
      let payload = self.verify_or_decrypt_payload(token.as_str())?;
      self
        .set_cel_claims(proxy_ctx, session, payload)
        .map_err(|e| e.to_string())?;
      Ok(())
    })();

    match result {
      Ok(()) => Ok(false),
      Err(_e) if matches!(self.on_error, JwtErrorModeConfig::Passthrough) => Ok(false),
      Err(_e) => self.deny_unauthorized(session).await,
    }
  }
}
