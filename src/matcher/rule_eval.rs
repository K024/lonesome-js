use std::sync::Arc;

use cel::objects::Opaque;
use cel::{Program, Value};

use super::cel_common::parent_context;
use super::cel_session_context::{cel_http_session_key, CelHttpSession};
use super::precheck::{build, Tri};

/// Three-valued result of the pre-check fast path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrecheckTri {
  True,
  False,
  Unknown,
}

/// Result of evaluating a matcher CEL rule against a synthetic request.
pub struct RuleEvaluation {
  pub precheck: PrecheckTri,
  pub matches: bool,
}

/// Evaluates a matcher CEL rule against a synthetic request built from minimal
/// inputs (method, path with query, optional headers); all other session inputs
/// take their defaults (see [`CelHttpSession::with_request`]).
///
/// `precheck` reports what the route fast path would have decided before
/// running the full CEL program: `True`/`False` mean it decided alone,
/// `Unknown` means it could not and the full program was consulted. When the
/// rule is not pre-checkable at all (e.g. a comparison at the root) the fast
/// path is skipped, reported as `Unknown`.
pub fn evaluate_rule(
  rule: &str,
  method: &str,
  path: &str,
  headers: Option<&[(String, String)]>,
) -> Result<RuleEvaluation, String> {
  let program =
    Program::compile(rule).map_err(|e| format!("failed to compile rule '{rule}': {e}"))?;

  let session = Arc::new(
    CelHttpSession::with_request(method, path, headers)
      .map_err(|e| format!("failed to build synthetic request: {e}"))?,
  );

  let mut ctx = parent_context().new_inner_scope();
  ctx.add_variable_from_value(
    cel_http_session_key(),
    Value::Opaque(session.clone() as Arc<dyn Opaque>),
  );

  let precheck = match build::<CelHttpSession>(program.expression()) {
    Some(expr) => match expr.eval(session.as_ref()) {
      Tri::True => PrecheckTri::True,
      Tri::False => PrecheckTri::False,
      Tri::Unknown => PrecheckTri::Unknown,
    },
    None => PrecheckTri::Unknown,
  };

  let matches = match program.execute(&ctx) {
    Ok(Value::Bool(v)) => v,
    Ok(other) => return Err(format!("rule returned non-boolean value: {other:?}")),
    Err(e) => return Err(format!("rule evaluation error: {e}")),
  };

  Ok(RuleEvaluation { precheck, matches })
}

/// Evaluates an arbitrary CEL expression (not necessarily boolean) against a
/// synthetic request and returns the result as JSON. This is the
/// general-purpose entry for non-matcher CEL usages (`body_expression`,
/// `set_variable`, `hashKeyRule`, ...) and for inspecting request-context
/// values (`HostValue()`, `ClientIPValue()`, ...).
///
/// `method`/`path`/`headers` build the synthetic session; when none are
/// meaningful the caller may pass the defaults. Results that cannot be
/// represented as JSON (opaque objects, durations, ...) are an error.
pub fn evaluate_expression(
  expression: &str,
  method: &str,
  path: &str,
  headers: Option<&[(String, String)]>,
) -> Result<serde_json::Value, String> {
  let program = Program::compile(expression)
    .map_err(|e| format!("failed to compile expression '{expression}': {e}"))?;

  let session = Arc::new(
    CelHttpSession::with_request(method, path, headers)
      .map_err(|e| format!("failed to build synthetic request: {e}"))?,
  );
  let mut ctx = parent_context().new_inner_scope();
  ctx.add_variable_from_value(
    cel_http_session_key(),
    Value::Opaque(session as Arc<dyn Opaque>),
  );

  let value = program
    .execute(&ctx)
    .map_err(|e| format!("expression evaluation error: {e}"))?;

  cel_value_to_json(&value)
    .ok_or_else(|| format!("expression result is not representable as JSON: {value:?}"))
}

/// Converts a CEL value into JSON. Returns `None` for values with no JSON
/// equivalent (opaque objects, durations, functions).
fn cel_value_to_json(value: &Value) -> Option<serde_json::Value> {
  match value {
    Value::Null => Some(serde_json::Value::Null),
    Value::Bool(v) => Some(serde_json::Value::Bool(*v)),
    Value::Int(v) => Some(serde_json::Value::from(*v)),
    Value::UInt(v) => Some(serde_json::Value::from(*v)),
    Value::Float(v) => serde_json::Number::from_f64(*v).map(serde_json::Value::Number),
    Value::String(v) => Some(serde_json::Value::String(v.to_string())),
    Value::Timestamp(v) => Some(serde_json::Value::String(v.to_rfc3339())),
    Value::Bytes(v) => {
      use base64::engine::general_purpose::STANDARD as BASE64;
      use base64::Engine as _;
      Some(serde_json::Value::String(BASE64.encode(v.as_slice())))
    }
    Value::List(items) => items
      .iter()
      .map(cel_value_to_json)
      .collect::<Option<Vec<_>>>()
      .map(serde_json::Value::Array),
    Value::Map(map) => {
      let mut obj = serde_json::Map::new();
      for (key, val) in map.map.iter() {
        let key = match key {
          cel::objects::Key::Int(v) => v.to_string(),
          cel::objects::Key::Uint(v) => v.to_string(),
          cel::objects::Key::Bool(v) => v.to_string(),
          cel::objects::Key::String(v) => v.to_string(),
        };
        obj.insert(key, cel_value_to_json(val)?);
      }
      Some(serde_json::Value::Object(obj))
    }
    _ => None,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn eval(
    rule: &str,
    method: &str,
    path: &str,
    headers: Option<&[(&str, &str)]>,
  ) -> RuleEvaluation {
    let headers: Option<Vec<(String, String)>> = headers.map(|hs| {
      hs.iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    });
    evaluate_rule(rule, method, path, headers.as_deref()).expect("evaluation should succeed")
  }

  #[test]
  fn cheap_host_path() {
    let r = eval(
      r#"Host("example.com") && PathPrefix("/api")"#,
      "GET",
      "/api/v1",
      Some(&[("host", "example.com")]),
    );
    assert_eq!(r.precheck, PrecheckTri::True);
    assert!(r.matches);

    let r = eval(
      r#"Host("example.com") && PathPrefix("/api")"#,
      "GET",
      "/api/v1",
      Some(&[("host", "other.com")]),
    );
    assert_eq!(r.precheck, PrecheckTri::False);
    assert!(!r.matches);
  }

  #[test]
  fn host_without_header_is_empty() {
    let r = eval(r#"Host("example.com")"#, "GET", "/", None);
    assert_eq!(r.precheck, PrecheckTri::False);
    assert!(!r.matches);
  }

  #[test]
  fn method_query_header() {
    let r = eval(
      r#"Method("POST") && Query("debug", "1") && Header("x-token", "abc")"#,
      "POST",
      "/submit?debug=1",
      Some(&[("x-token", "abc")]),
    );
    assert_eq!(r.precheck, PrecheckTri::Unknown);
    assert!(r.matches);

    let r = eval(
      r#"Method("POST") && Query("debug", "1") && Header("x-token", "abc")"#,
      "POST",
      "/submit?debug=1",
      Some(&[("x-token", "nope")]),
    );
    assert!(!r.matches);
  }

  #[test]
  fn unanalyzable_rule_reports_unknown_precheck() {
    let r = eval(r#"PathValue().startsWith("/api")"#, "GET", "/api/v1", None);
    assert_eq!(r.precheck, PrecheckTri::Unknown);
    assert!(r.matches);
  }

  #[test]
  fn precheck_and_cel_never_disagree_on_decidable_rules() {
    // For rules the fast path can decide, the pre-check must equal the real CEL
    // result (soundness); Unknown means only the full program decided.
    let cases: &[(&str, &str, &str, Option<&[(&str, &str)]>, bool)] = &[
      (r#"Host("a")"#, "GET", "/", Some(&[("host", "a")]), true),
      (r#"Host("a")"#, "GET", "/", Some(&[("host", "b")]), false),
      (r#"!Host("a")"#, "GET", "/", Some(&[("host", "b")]), true),
      (r#"!Host("a")"#, "GET", "/", Some(&[("host", "a")]), false),
      (
        r#"Host("a") && Path("/x")"#,
        "GET",
        "/x",
        Some(&[("host", "a")]),
        true,
      ),
      (
        r#"Host("a") && Path("/x")"#,
        "GET",
        "/y",
        Some(&[("host", "a")]),
        false,
      ),
      (
        r#"Host("a") ? Path("/x") : Path("/y")"#,
        "GET",
        "/x",
        Some(&[("host", "a")]),
        true,
      ),
      (
        r#"Host("a") ? Path("/x") : Path("/y")"#,
        "GET",
        "/y",
        Some(&[("host", "a")]),
        false,
      ),
      (
        r#"Host("a") ? Path("/x") : Path("/y")"#,
        "GET",
        "/y",
        Some(&[("host", "b")]),
        true,
      ),
      (
        r#"Host("a") ? Path("/x") : Path("/y")"#,
        "GET",
        "/x",
        Some(&[("host", "b")]),
        false,
      ),
    ];
    for (rule, method, path, headers, expected) in cases {
      let r = eval(rule, method, path, *headers);
      assert_eq!(r.matches, *expected, "CEL mismatch: {rule} {path}");
      if r.precheck != PrecheckTri::Unknown {
        assert_eq!(
          (r.precheck == PrecheckTri::True),
          *expected,
          "precheck disagreed with CEL: {rule} {path}"
        );
      }
    }
  }

  #[test]
  fn errors_are_surfaced() {
    assert!(
      evaluate_rule("Host(", "GET", "/", None).is_err(),
      "compile error"
    );
    assert!(
      evaluate_rule(
        r#"PathPrefix("/") && NonExistFunction("x")"#,
        "GET",
        "/",
        None
      )
      .is_err(),
      "runtime error"
    );
    assert!(
      evaluate_rule(r#"PathValue()"#, "GET", "/", None).is_err(),
      "non-boolean result"
    );
  }

  fn eval_expr(expr: &str, path: &str, headers: Option<&[(&str, &str)]>) -> serde_json::Value {
    let headers: Option<Vec<(String, String)>> = headers.map(|hs| {
      hs.iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    });
    evaluate_expression(expr, "GET", path, headers.as_deref())
      .expect("expression evaluation should succeed")
  }

  #[test]
  fn expression_pure_scalars() {
    assert_eq!(eval_expr("1 + 2", "/", None), serde_json::json!(3));
    assert_eq!(
      eval_expr(r#""a" + "b""#, "/", None),
      serde_json::json!("ab")
    );
    assert_eq!(
      eval_expr("true && false", "/", None),
      serde_json::json!(false)
    );
  }

  #[test]
  fn expression_context_values() {
    let v = eval_expr(
      r#"MethodValue() + "|" + HostValue() + "|" + PathValue()"#,
      "/api/v1",
      Some(&[("host", "example.com")]),
    );
    assert_eq!(v, serde_json::json!("GET|example.com|/api/v1"));
  }

  #[test]
  fn expression_non_scalar() {
    assert_eq!(
      eval_expr(r#"["a", "b"]"#, "/", None),
      serde_json::json!(["a", "b"])
    );
    assert_eq!(
      eval_expr(r#"{"k": PathValue(), "n": 2}"#, "/x", None),
      serde_json::json!({ "k": "/x", "n": 2 })
    );
  }

  #[test]
  fn expression_errors() {
    assert!(
      evaluate_expression("1 +", "GET", "/", None).is_err(),
      "compile error"
    );
    assert!(
      evaluate_expression("NonExistFunction()", "GET", "/", None).is_err(),
      "runtime error"
    );
    assert!(
      evaluate_expression(r#"duration("1h")"#, "GET", "/", None).is_err(),
      "non-serializable result"
    );
  }
}
