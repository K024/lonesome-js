use std::collections::HashMap;

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use cel::{Program, Value};
use pingora::http::ResponseHeader;
use pingora::proxy::Session;
use pingora::Result;
use serde::Deserialize;

use crate::matcher::cel_session_context::ensure_context;
use crate::middlewares::middleware::middleware_internal_error;
use crate::middlewares::Middleware;
use crate::proxy::ctx::ProxyCtx;

#[derive(Clone, Debug, Deserialize)]
pub struct BasicUser {
  pub name: String,
  pub password_hash: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct BasicAuthConfig {
  pub realm: Option<String>,
  pub users: Vec<BasicUser>,
  pub rule: Option<String>,
}

impl BasicAuthConfig {
  pub fn validate(&self) -> Result<(), String> {
    if self.users.is_empty() {
      return Err("middleware basic_auth.users cannot be empty".to_string());
    }

    for user in &self.users {
      if user.name.trim().is_empty() {
        return Err("middleware basic_auth.users[].name cannot be empty".to_string());
      }
      if user.password_hash.trim().is_empty() {
        return Err("middleware basic_auth.users[].password_hash cannot be empty".to_string());
      }
    }

    Ok(())
  }
}

pub struct BasicAuthMiddleware {
  realm: String,
  users: HashMap<String, String>,
  cel_program: Option<Program>,
}

impl BasicAuthMiddleware {
  pub fn from_config(cfg: BasicAuthConfig) -> Result<Self, String> {
    cfg.validate()?;

    let cel_program = if let Some(expr) = cfg.rule {
      Some(
        Program::compile(&expr)
          .map_err(|e| format!("failed to compile basic_auth rule '{expr}': {e}"))?,
      )
    } else {
      None
    };

    let mut users = HashMap::with_capacity(cfg.users.len());
    for user in cfg.users {
      users.insert(user.name, user.password_hash);
    }

    Ok(Self {
      realm: cfg.realm.unwrap_or_else(|| "restricted".to_string()),
      users,
      cel_program,
    })
  }

  fn should_apply(&self, proxy_ctx: &mut ProxyCtx, session: &Session) -> bool {
    let Some(program) = &self.cel_program else {
      return true;
    };

    let ctx = ensure_context(session, proxy_ctx);
    matches!(program.execute(ctx), Ok(Value::Bool(true)))
  }

  async fn issue_challenge(&self, session: &mut Session) -> Result<bool> {
    let mut resp = ResponseHeader::build(401, Some(3))
      .map_err(|e| middleware_internal_error("basic_auth build 401 failed", e.to_string()))?;
    resp
      .insert_header(
        "WWW-Authenticate",
        format!("Basic realm=\"{}\", charset=\"UTF-8\"", self.realm),
      )
      .map_err(|e| {
        middleware_internal_error("basic_auth insert www-authenticate failed", e.to_string())
      })?;
    resp.insert_header("Content-Length", "0").map_err(|e| {
      middleware_internal_error("basic_auth insert content-length failed", e.to_string())
    })?;

    session
      .write_response_header(Box::new(resp), true)
      .await
      .map_err(|e| middleware_internal_error("basic_auth write 401 failed", e.to_string()))?;

    Ok(true)
  }

  fn parse_basic_credentials(auth_value: &str) -> Option<(String, String)> {
    if !auth_value.starts_with("Basic ") {
      return None;
    }

    let encoded = auth_value.trim_start_matches("Basic ").trim();
    let raw = BASE64_STANDARD.decode(encoded).ok()?;
    let decoded = std::str::from_utf8(&raw).ok()?;
    let (username, password) = decoded.split_once(':')?;
    Some((username.to_string(), password.to_string()))
  }

  fn verify_password(password: &str, hash_str: &str) -> bool {
    matches!(
      password_auth::verify_password(password.as_bytes(), hash_str),
      Ok(())
    )
  }

  async fn authenticate(&self, session: &mut Session) -> Result<bool> {
    let auth_value = session
      .req_header()
      .headers
      .get("authorization")
      .and_then(|v| v.to_str().ok())
      .map(str::trim)
      .unwrap_or("");

    let Some((username, password)) = Self::parse_basic_credentials(auth_value) else {
      return self.issue_challenge(session).await;
    };

    let Some(hash_str) = self.users.get(&username) else {
      return self.issue_challenge(session).await;
    };

    if !Self::verify_password(password.as_str(), hash_str.as_str()) {
      return self.issue_challenge(session).await;
    }

    Ok(false)
  }
}

#[async_trait]
impl Middleware for BasicAuthMiddleware {
  async fn request_filter(&self, proxy_ctx: &mut ProxyCtx, session: &mut Session) -> Result<bool> {
    if !self.should_apply(proxy_ctx, session) {
      return Ok(false);
    }

    self.authenticate(session).await
  }
}
