use napi::bindgen_prelude::Result;
use napi_derive::napi;

use crate::bindings::error::to_napi_error;
use crate::matcher::{analyze, RuleConstraints as CoreConstraints};

#[napi(object)]
pub struct RuleConstraints {
  pub hosts: Vec<String>,
  pub paths: Vec<String>,
  pub path_prefixes: Vec<String>,
  /// Whether the whole expression can be decided by the pre-checker alone
  /// (no unknown leaves), so the full CEL program is never consulted. Note
  /// this is NOT a claim that `hosts` is exact: e.g.
  /// `Host("a") ? Path("/x") : PathPrefix("/y")` is fully pre-checkable yet
  /// still matches arbitrary hosts through its else branch.
  pub fully_precheckable: bool,
}

/// Statically analyzes a matcher CEL rule for the `Host`/`Path`/`PathPrefix`
/// string-literal constraints it references. Intended for certificate
/// automation: `hosts` are the hostnames the rule can require, including
/// `*.example.com` wildcard patterns (which line up with a wildcard
/// certificate).
///
/// The extraction is conservative and must be read as a lower bound for
/// provisioning: every `Host` literal is reported regardless of context (under
/// `!`, in a ternary branch, on either side of `||`), while negations,
/// conditional structure, and unanalyzable sub-expressions are ignored.
/// Over-provisioning (listing a host that never matches) is harmless; callers
/// must provision a wildcard fallback whenever the rule contains unanalyzable
/// parts, so the reported `hosts` plus that fallback never misses a required
/// certificate.
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
    fully_precheckable: c.fully_precheckable,
  })
}
