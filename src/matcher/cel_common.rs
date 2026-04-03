use std::net::IpAddr;
use std::str::FromStr;
use std::sync::{Arc, OnceLock};

use cel::{Context, FunctionContext, Value};
use form_urlencoded;
use ipnet::IpNet;
use serde_json::Value as JsonValue;

use super::cel_regex;
use super::cel_session_context::{cel_http_session_key, CelHttpSession};

fn with_session<R>(ftx: &FunctionContext, f: impl FnOnce(&CelHttpSession) -> R) -> Option<R> {
  let val = ftx.ptx.get_variable(cel_http_session_key())?;
  let Ok(Value::Opaque(opaque)) = Value::try_from(val.as_ref()) else {
    return None;
  };
  let session = opaque.downcast_ref::<CelHttpSession>()?;
  Some(f(session))
}

fn host(ftx: &FunctionContext, expected: Arc<String>) -> bool {
  with_session(ftx, |s| s.host() == expected.as_str()).unwrap_or(false)
}

fn host_regexp(ftx: &FunctionContext, pattern: Arc<String>) -> bool {
  with_session(ftx, |session| {
    cel_regex::is_match(pattern.as_str(), &session.host())
  })
  .unwrap_or(false)
}

fn method(ftx: &FunctionContext, expected: Arc<String>) -> bool {
  with_session(ftx, |s| s.method() == expected.as_str()).unwrap_or(false)
}

fn path(ftx: &FunctionContext, expected: Arc<String>) -> bool {
  with_session(ftx, |s| s.path() == expected.as_str()).unwrap_or(false)
}

fn path_prefix(ftx: &FunctionContext, prefix: Arc<String>) -> bool {
  with_session(ftx, |s| s.path().starts_with(prefix.as_str())).unwrap_or(false)
}

fn path_regexp(ftx: &FunctionContext, pattern: Arc<String>) -> bool {
  with_session(ftx, |session| {
    cel_regex::is_match(pattern.as_str(), &session.path())
  })
  .unwrap_or(false)
}

fn client_ip(ftx: &FunctionContext, ip_or_cidr: Arc<String>) -> bool {
  with_session(ftx, |session| {
    client_ip_matches(&session.client_ip(), ip_or_cidr.as_str())
  })
  .unwrap_or(false)
}

fn header(ftx: &FunctionContext, key: Arc<String>, value: Arc<String>) -> bool {
  with_session(ftx, |session| {
    session
      .req_header()
      .headers
      .get_all(key.as_str())
      .iter()
      .filter_map(|v| v.to_str().ok())
      .any(|v| v == value.as_str())
  })
  .unwrap_or(false)
}

fn header_regexp(ftx: &FunctionContext, key: Arc<String>, pattern: Arc<String>) -> bool {
  with_session(ftx, |session| {
    session
      .req_header()
      .headers
      .get_all(key.as_str())
      .iter()
      .filter_map(|v| v.to_str().ok())
      .any(|v| cel_regex::is_match(pattern.as_str(), v))
  })
  .unwrap_or(false)
}

fn query(ftx: &FunctionContext, key: Arc<String>, value: Arc<String>) -> bool {
  with_session(ftx, |session| {
    form_urlencoded::parse(
      session
        .req_header()
        .uri
        .query()
        .unwrap_or_default()
        .as_bytes(),
    )
    .any(|(k, v)| k.as_ref() == key.as_str() && v.as_ref() == value.as_str())
  })
  .unwrap_or(false)
}

fn query_regexp(ftx: &FunctionContext, key: Arc<String>, pattern: Arc<String>) -> bool {
  with_session(ftx, |session| {
    form_urlencoded::parse(
      session
        .req_header()
        .uri
        .query()
        .unwrap_or_default()
        .as_bytes(),
    )
    .filter(|(k, _)| k.as_ref() == key.as_str())
    .any(|(_, v)| cel_regex::is_match(pattern.as_str(), v.as_ref()))
  })
  .unwrap_or(false)
}

fn header_value(ftx: &FunctionContext, key: Arc<String>) -> String {
  with_session(ftx, |session| {
    session
      .req_header()
      .headers
      .get(key.as_str())
      .and_then(|v| v.to_str().ok())
      .unwrap_or_default()
      .to_string()
  })
  .unwrap_or_default()
}

fn host_value(ftx: &FunctionContext) -> String {
  with_session(ftx, |s| s.host()).unwrap_or_default()
}

fn method_value(ftx: &FunctionContext) -> String {
  with_session(ftx, |s| s.method()).unwrap_or_default()
}

fn path_value(ftx: &FunctionContext) -> String {
  with_session(ftx, |s| s.path()).unwrap_or_default()
}

fn query_value(ftx: &FunctionContext, key: Arc<String>) -> String {
  with_session(ftx, |session| {
    form_urlencoded::parse(
      session
        .req_header()
        .uri
        .query()
        .unwrap_or_default()
        .as_bytes(),
    )
    .find_map(|(k, v)| {
      if k.as_ref() == key.as_str() {
        Some(v.into_owned())
      } else {
        None
      }
    })
    .unwrap_or_default()
  })
  .unwrap_or_default()
}

fn client_ip_value(ftx: &FunctionContext) -> String {
  with_session(ftx, |s| s.client_ip()).unwrap_or_default()
}

fn response_status_value(ftx: &FunctionContext) -> i64 {
  with_session(ftx, |s| s.response_status_value()).unwrap_or(0)
}

fn response_header_value(ftx: &FunctionContext, key: Arc<String>) -> String {
  with_session(ftx, |s| s.response_header_value(key.as_str())).unwrap_or_default()
}

fn jwt_claim(ftx: &FunctionContext, key: Arc<String>, expected: Arc<String>) -> bool {
  with_session(ftx, |s| {
    let Some(claim) = s.jwt_claim_value(key.as_str()) else {
      return false;
    };

    match claim {
      JsonValue::String(v) => v == expected.as_str(),
      JsonValue::Number(v) => v.to_string() == expected.as_str(),
      _ => false,
    }
  })
  .unwrap_or(false)
}

fn jwt_claim_value(ftx: &FunctionContext, key: Arc<String>) -> Result<Value, cel::ExecutionError> {
  let claim = with_session(ftx, |s| s.jwt_claim_value(key.as_str())).flatten();
  cel::to_value(claim.unwrap_or(JsonValue::Null)).map_err(|e| {
    cel::ExecutionError::function_error(
      "JwtClaimValue",
      format!("failed to convert claim to cel value: {e}"),
    )
  })
}

fn jwt_payload_value(ftx: &FunctionContext) -> String {
  with_session(ftx, |s| s.jwt_payload_string())
    .flatten()
    .unwrap_or_default()
}

fn client_ip_matches(actual: &str, expected: &str) -> bool {
  let Ok(actual_ip) = actual.parse::<IpAddr>() else {
    return false;
  };

  if let Ok(expected_ip) = expected.parse::<IpAddr>() {
    return actual_ip == expected_ip;
  }

  IpNet::from_str(expected)
    .map(|network| network.contains(&actual_ip))
    .unwrap_or(false)
}

pub fn parent_context() -> &'static Context<'static> {
  static PARENT: OnceLock<Context<'static>> = OnceLock::new();

  PARENT.get_or_init(|| {
    let mut ctx = Context::default();
    ctx.add_function("Header", header);
    ctx.add_function("HeaderRegexp", header_regexp);
    ctx.add_function("Host", host);
    ctx.add_function("HostRegexp", host_regexp);
    ctx.add_function("Method", method);
    ctx.add_function("Path", path);
    ctx.add_function("PathPrefix", path_prefix);
    ctx.add_function("PathRegexp", path_regexp);
    ctx.add_function("Query", query);
    ctx.add_function("QueryRegexp", query_regexp);
    ctx.add_function("ClientIP", client_ip);

    // Value functions
    // TODO: update getters to return Option<T>
    ctx.add_function("HeaderValue", header_value);
    ctx.add_function("HostValue", host_value);
    ctx.add_function("MethodValue", method_value);
    ctx.add_function("PathValue", path_value);
    ctx.add_function("QueryValue", query_value);
    ctx.add_function("ClientIPValue", client_ip_value);

    // Response functions
    ctx.add_function("ResponseStatusValue", response_status_value);
    ctx.add_function("ResponseHeaderValue", response_header_value);

    // Auth functions
    ctx.add_function("JwtClaim", jwt_claim);
    ctx.add_function("JwtClaimValue", jwt_claim_value);
    ctx.add_function("JwtPayloadValue", jwt_payload_value);

    ctx
  })
}
