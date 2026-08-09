use napi::bindgen_prelude::Result;
use napi_derive::napi;

use crate::bindings::error::to_napi_error;
use crate::matcher::{evaluate_expression as core_evaluate_expression, evaluate_rule as core_evaluate_rule, PrecheckTri};

#[napi(object)]
pub struct HeaderInput {
  pub name: String,
  pub value: String,
}

#[napi(object)]
pub struct RequestOptions {
  pub method: String,
  pub path: String,
  pub headers: Option<Vec<HeaderInput>>,
}

#[napi(object)]
pub struct RuleEvaluation {
  /// The pre-check (fast path) result. `true`/`false` mean the fast path
  /// decided the rule by itself; `unknown` means it could not and the full CEL
  /// program was consulted.
  #[napi(ts_type = "'true' | 'false' | 'unknown'")]
  pub precheck: String,
  /// Whether the rule matches the given request.
  pub matches: bool,
}

/// Evaluates a matcher CEL rule against a synthetic request built from minimal
/// inputs (method, path including query, optional headers). All other request
/// attributes take their defaults: no TLS SNI, empty `ClientIP`, no JWT
/// payload, no upstream response header, `RequestTime` = now.
///
/// `precheck` reports what the route fast path would decide before running the
/// full CEL program: it is `'unknown'` for rules the fast path cannot handle or
/// fully decide. When the pre-check is `'true'`/`'false'` it always agrees with
/// `matches`.
///
/// Evaluation errors (compile failure, unknown function at runtime, non-boolean
/// result) are returned as errors rather than silently treated as no match.
#[napi]
pub fn evaluate_rule(rule: String, request: RequestOptions) -> Result<RuleEvaluation> {
  let headers: Option<Vec<(String, String)>> = request
    .headers
    .map(|hs| hs.into_iter().map(|h| (h.name, h.value)).collect());
  let r =
    core_evaluate_rule(&rule, &request.method, &request.path, headers.as_deref())
      .map_err(|e| to_napi_error(e))?;

  Ok(RuleEvaluation {
    precheck: match r.precheck {
      PrecheckTri::True => "true".to_string(),
      PrecheckTri::False => "false".to_string(),
      PrecheckTri::Unknown => "unknown".to_string(),
    },
    matches: r.matches,
  })
}

/// Evaluates an arbitrary CEL expression against an optional synthetic request
/// and returns the resulting value (string/number/boolean/list/object/null).
/// This is the general-purpose entry for every non-matcher CEL usage
/// (`respond.body_expression`, `set_variable.expression`,
/// `request_headers`/`response_headers.expression`, `rewrite`/`redirect` cel
/// modes, `rate_limit` key, `loadBalancer.hashKeyRule`) and doubles as a
/// request-context inspector (`HostValue()`, `PathValue()`, `ClientIPValue()`,
/// `RequestTime()`, ...).
///
/// When `request` is omitted a default session is used (GET `/`, no headers);
/// session functions then see their empty defaults. Compile/runtime errors and
/// results that cannot be represented as JSON (e.g. opaque objects, durations)
/// are returned as errors.
#[napi]
pub fn evaluate_expression(
  expression: String,
  request: Option<RequestOptions>,
) -> Result<serde_json::Value> {
  let (method, path, headers) = match request {
    Some(r) => (
      r.method,
      r.path,
      r.headers
        .map(|hs| hs.into_iter().map(|h| (h.name, h.value)).collect::<Vec<_>>()),
    ),
    None => ("GET".to_string(), "/".to_string(), None),
  };

  core_evaluate_expression(&expression, &method, &path, headers.as_deref())
    .map_err(|e| to_napi_error(e))
}
