use napi::bindgen_prelude::Result;
use napi_derive::napi;

use crate::bindings::error::to_napi_error;
use crate::matcher::{analyze, RuleConstraints as CoreConstraints};

#[napi(object)]
pub struct RuleConstraints {
  pub hosts: Vec<String>,
  pub paths: Vec<String>,
  pub path_prefixes: Vec<String>,
}

/// Statically analyzes a matcher CEL rule for the `Host`/`Path`/`PathPrefix`
/// string-literal constraints it references. Intended for certificate
/// automation: `hosts` are the exact hostnames the rule can match, including
/// `*.example.com` wildcard patterns (which line up with a wildcard
/// certificate).
///
/// Only simple boolean rules are analyzed (`Host`/`Path`/`PathPrefix` literals
/// combined with `&&`/`||`/`!`/`?:`). Complex CEL such as `HostRegexp`,
/// comparisons or member calls is not supported and must be handled by the
/// caller.
#[napi]
pub fn analyze_rule(rule: String) -> Result<RuleConstraints> {
  let program = cel::Program::compile(&rule)
    .map_err(|e| to_napi_error(format!("failed to compile rule '{rule}': {e}")))?;

  let c: CoreConstraints = analyze(program.expression());
  Ok(RuleConstraints {
    hosts: c.hosts,
    paths: c.paths,
    path_prefixes: c.path_prefixes,
  })
}
