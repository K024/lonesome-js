use cel::common::ast::operators::{CONDITIONAL, LOGICAL_AND, LOGICAL_NOT, LOGICAL_OR};
use cel::common::ast::{CallExpr, Expr, IdedExpr, LiteralValue};

use super::expr::CheapExpr;

const FN_HOST: &str = "Host";
const FN_PATH: &str = "Path";
const FN_PATH_PREFIX: &str = "PathPrefix";

/// Request attributes that concrete cheap-check leaves consult.
///
/// `CheapExpr` itself never needs this trait (`eval` only invokes the leaf
/// closures); it is required only to build those closures from the CEL AST.
/// Concrete sources (e.g. `CelHttpSession`) implement this trait in their own
/// module. Adding a new cheap capability extends this trait plus one leaf in
/// [`build`], without touching the pure evaluator.
pub trait Source {
  fn host(&self) -> &str;
  fn path(&self) -> &str;
}

/// Builds a cheap boolean constraint from a compiled CEL expression.
///
/// Returns `None` when the root of the expression cannot be partially
/// evaluated safely (e.g. the root is a comparison, a comprehension or an
/// unknown function call). In that case no pre-filter should be applied and
/// the full CEL program is the only source of truth.
pub fn build<C: Source + ?Sized>(expr: &IdedExpr) -> Option<CheapExpr<C>> {
  match &expr.expr {
    Expr::Call(call) => build_call(call),
    Expr::Literal(LiteralValue::Boolean(v)) => Some(CheapExpr::Lit(*v.inner())),
    _ => None,
  }
}

fn build_call<C: Source + ?Sized>(call: &CallExpr) -> Option<CheapExpr<C>> {
  if call.target.is_some() {
    return None;
  }

  match call.func_name.as_str() {
    FN_HOST | FN_PATH | FN_PATH_PREFIX => {
      let mut args = call.args.iter();
      let arg = args.next()?;
      if args.next().is_some() {
        return None;
      }
      let Expr::Literal(LiteralValue::String(value)) = &arg.expr else {
        return None;
      };
      let value = value.inner().to_string();
      let check: Box<dyn Fn(&C) -> bool + Send + Sync> = match call.func_name.as_str() {
        FN_PATH => Box::new(move |ctx: &C| ctx.path() == value.as_str()),
        FN_PATH_PREFIX => Box::new(move |ctx: &C| ctx.path().starts_with(value.as_str())),
        _ => Box::new(move |ctx: &C| ctx.host() == value.as_str()),
      };
      Some(CheapExpr::Check(check))
    }
    LOGICAL_AND if call.args.len() == 2 => {
      Some(CheapExpr::And(
        Box::new(build_opt(&call.args[0])),
        Box::new(build_opt(&call.args[1])),
      ))
    }
    LOGICAL_OR if call.args.len() == 2 => {
      Some(CheapExpr::Or(
        Box::new(build_opt(&call.args[0])),
        Box::new(build_opt(&call.args[1])),
      ))
    }
    LOGICAL_NOT if call.args.len() == 1 => {
      Some(CheapExpr::Not(Box::new(build_opt(&call.args[0]))))
    }
    CONDITIONAL if call.args.len() == 3 => {
      Some(CheapExpr::Cond(
        Box::new(build_opt(&call.args[0])),
        Box::new(build_opt(&call.args[1])),
        Box::new(build_opt(&call.args[2])),
      ))
    }
    _ => None,
  }
}

/// Like `build`, but collapses unoptimizable sub-expressions into `Unknown`
/// so that recognized logical wrappers (e.g. `Host("a") && Header(...)`) still
/// get a sound pre-filter from their cheap part.
fn build_opt<C: Source + ?Sized>(expr: &IdedExpr) -> CheapExpr<C> {
  build(expr).unwrap_or(CheapExpr::Unknown)
}

#[cfg(test)]
mod tests {
  use std::sync::Arc;

  use cel::objects::Opaque;
  use cel::Program;
  use cel::Value;

  use crate::matcher::cel_common::parent_context;
  use crate::matcher::cel_session_context::{cel_http_session_key, CelHttpSession};
  use crate::matcher::precheck::{CheapExpr, Tri};

  use super::{build, Source};

  impl Source for (&str, &str) {
    fn host(&self) -> &str {
      self.0
    }

    fn path(&self) -> &str {
      self.1
    }
  }

  fn t(source: &str) -> CheapExpr<(&'static str, &'static str)> {
    let program = Program::compile(source).expect("rule should compile");
    build(program.expression()).expect("rule should be buildable")
  }

  fn t_none(source: &str) {
    let program = Program::compile(source).expect("rule should compile");
    assert!(
      build::<(&'static str, &'static str)>(program.expression()).is_none(),
      "expected None for {source}"
    );
  }

  #[test]
  fn exact_checks() {
    let host = t(r#"Host("example.com")"#);
    assert_eq!(host.eval(&("example.com", "/")), Tri::True);
    assert_eq!(host.eval(&("other.com", "/")), Tri::False);

    let path = t(r#"Path("/api")"#);
    assert_eq!(path.eval(&("h", "/api")), Tri::True);
    assert_eq!(path.eval(&("h", "/api/")), Tri::False);

    let prefix = t(r#"PathPrefix("/api")"#);
    assert_eq!(prefix.eval(&("h", "/api/v1")), Tri::True);
    assert_eq!(
      prefix.eval(&("h", "/apix")),
      Tri::True,
      "PathPrefix uses starts_with, same as the CEL function"
    );
    assert_eq!(prefix.eval(&("h", "/other")), Tri::False);
  }

  #[test]
  fn mixed_logic() {
    // !PathPrefix("/api") || Host("example.com")
    let rule = t(r#"!PathPrefix("/api") || Host("example.com")"#);
    assert_eq!(
      rule.eval(&("example.com.other", "/api/x")),
      Tri::False,
      "neither the negation nor the host matches"
    );
    assert_eq!(rule.eval(&("anything", "/other")), Tri::True);
    assert_eq!(rule.eval(&("example.com", "/api/x")), Tri::True);
  }

  #[test]
  fn negation_keeps_polarity() {
    let rule = t(r#"!Host("a")"#);
    assert_eq!(rule.eval(&("b", "/")), Tri::True);
    assert_eq!(rule.eval(&("a", "/")), Tri::False);
  }

  #[test]
  fn unknown_leaves() {
    // Host("a") && Header("x","y")
    let rule = t(r#"Host("a") && Header("x", "y")"#);
    assert_eq!(rule.eval(&("a", "/")), Tri::Unknown);
    assert_eq!(rule.eval(&("b", "/")), Tri::False);

    // Host("a") || Header("x","y") -> True dominates unknown when host matches,
    // which is sound: the full CEL program also short-circuits to true here.
    let rule = t(r#"Host("a") || Header("x", "y")"#);
    assert_eq!(rule.eval(&("a", "/")), Tri::True);
    assert_eq!(rule.eval(&("b", "/")), Tri::Unknown);
  }

  #[test]
  fn ternary() {
    let rule = t(r#"Host("a") ? Path("/x") : PathPrefix("/y")"#);
    assert_eq!(rule.eval(&("a", "/x")), Tri::True);
    assert_eq!(rule.eval(&("a", "/y")), Tri::False);
    assert_eq!(rule.eval(&("b", "/y")), Tri::True);
    assert_eq!(rule.eval(&("b", "/x")), Tri::False);
  }

  #[test]
  fn non_optimizable_roots() {
    t_none(r#"PathValue() == "/x""#);
    t_none(r#"Header("x", "y")"#);
    t_none(r#"Host(HostValue())"#);
    t_none(r#"size([1]) > 0"#);
    t_none(r#"Host("a") == true"#);
  }

  /// Every possible result of the unknown leaves, as [has_false, has_true].
  fn possible(
    e: &CheapExpr<(&'static str, &'static str)>,
    host: &'static str,
    path: &'static str,
  ) -> [bool; 2] {
    match e {
      CheapExpr::Unknown => [true, true],
      CheapExpr::Lit(v) => {
        let mut r = [false, false];
        r[*v as usize] = true;
        r
      }
      CheapExpr::Check(f) => {
        let ctx = (host, path);
        let mut r = [false, false];
        r[f(&ctx) as usize] = true;
        r
      }
      CheapExpr::Not(inner) => {
        let [f, t] = possible(inner, host, path);
        [t, f]
      }
      CheapExpr::And(a, b) => {
        let [af, at] = possible(a, host, path);
        let [bf, bt] = possible(b, host, path);
        [(af && bf) || (af && bt) || (at && bf), at && bt]
      }
      CheapExpr::Or(a, b) => {
        let [af, at] = possible(a, host, path);
        let [bf, bt] = possible(b, host, path);
        [af && bf, (at && bf) || (at && bt) || (af && bt)]
      }
      CheapExpr::Cond(cond, then, els) => {
        let [cf, ct] = possible(cond, host, path);
        let [tf, tt] = possible(then, host, path);
        let [ef, et] = possible(els, host, path);
        [(cf && ef) || (ct && tf), (cf && et) || (ct && tt)]
      }
    }
  }

  fn assert_kleene_consistent(
    e: &CheapExpr<(&'static str, &'static str)>,
    host: &'static str,
    path: &'static str,
  ) {
    let [has_false, has_true] = possible(e, host, path);
    match e.eval(&(host, path)) {
      Tri::True => assert!(
        has_true && !has_false,
        "eval=True but not all-completions-true: {host} {path}"
      ),
      Tri::False => assert!(
        has_false && !has_true,
        "eval=False but some completion is true: {host} {path}"
      ),
      Tri::Unknown => assert!(has_true && has_false, "eval=U but results are not split: {host} {path}"),
    }
  }

  const RULES: [&str; 24] = [
    // Pure cheap: no unknown leaves, eval is exact
    r#"Host("a")"#,
    r#"Path("/x")"#,
    r#"PathPrefix("/api")"#,
    r#"Host("a") || Host("b")"#,
    r#"Host("a") && Path("/x") && PathPrefix("/api")"#,
    r#"PathPrefix("/api") && !Path("/x")"#,
    r#"!Host("a") && Path("/x")"#,
    r#"!!Host("a")"#,
    r#"!Host("a") || !Host("b")"#,
    r#"true"#,
    r#"false"#,
    r#"!false"#,
    r#"Host("a") ? Path("/x") : PathPrefix("/y")"#,
    // Mixed with unknown leaves
    r#"!PathPrefix("/api") || Host("b")"#,
    r#"Host("a") && Header("h", "v")"#,
    r#"Host("a") || JwtClaim("role", "admin")"#,
    r#"!Header("h", "v") && Host("a")"#,
    r#"!(Host("a") || Header("h", "v"))"#,
    r#"Host("a") ? Header("h", "v") : Path("/x")"#,
    r#"Header("h", "v") ? Path("/x") : Host("a")"#,
    r#"Host("a") || (PathPrefix("/api") && Header("h", "v"))"#,
    r#"(Host("a") || Host("b")) && PathPrefix("/api")"#,
    r#"Host("a") && (PathPrefix("/api") || Header("h", "v"))"#,
    r#"PathPrefix("/api") && PathValue().startsWith("/api/v1")"#,
  ];

  const HOSTS: [&str; 3] = ["a", "b", "example.com"];
  const PATHS: [&str; 4] = ["/x", "/api", "/api/v1", "/other"];

  #[test]
  fn kleene_matches_definition() {
    for rule in RULES {
      let expr = t(rule);
      for host in HOSTS {
        for path in PATHS {
          assert_kleene_consistent(&expr, host, path);
        }
      }
    }
  }

  /// Runs the real CEL program with the real matcher functions against a
  /// `CelHttpSession` seeded with the given host/path.
  fn run_cel(rule: &str, host: &str, path: &str) -> bool {
    let program = Program::compile(rule).expect("rule should compile");
    let session = Arc::new(CelHttpSession::with_host_path(host, path));
    let mut ctx = parent_context().new_inner_scope();
    ctx.add_variable_from_value(
      cel_http_session_key(),
      Value::Opaque(session as Arc<dyn Opaque>),
    );
    matches!(program.execute(&ctx), Ok(Value::Bool(v)) if v)
  }

  fn assert_differential(rule: &str, host: &'static str, path: &'static str) {
    let tri = t(rule).eval(&(host, path));
    let actual = run_cel(rule, host, path);
    match tri {
      Tri::True => assert!(actual, "cheap=True but CEL false: {rule} {host} {path}"),
      Tri::False => assert!(!actual, "cheap=False but CEL true: {rule} {host} {path}"),
      Tri::Unknown => {}
    }
  }

  #[test]
  fn differential_against_real_cel() {
    for rule in RULES {
      for host in HOSTS {
        for path in PATHS {
          assert_differential(rule, host, path);
        }
      }
    }
  }

  #[test]
  fn value_and_string_expressions_fall_back_to_cel() {
    // `XXXValue() == xxx` comparisons and string stdlib member calls are not
    // cheap-optimizable: build must yield None (the full CEL program decides)
    // and the real CEL must evaluate as expected against the seeded session
    // (host/path preset, method GET, empty query/headers).
    let cases: &[(&str, &str, &str, bool)] = &[
      (r#"PathValue() == "/x""#, "a", "/x", true),
      (r#"PathValue() == "/x""#, "a", "/api", false),
      (r#"HostValue() == "a""#, "a", "/", true),
      (r#"HostValue() == "a""#, "b", "/", false),
      (r#"MethodValue() == "GET""#, "a", "/", true),
      (r#"MethodValue() == "POST""#, "a", "/", false),
      (r#"PathValue().startsWith("/api")"#, "a", "/api/v1", true),
      (r#"PathValue().startsWith("/api")"#, "a", "/other", false),
      (r#"PathValue().endsWith(".js")"#, "a", "/app.js", true),
      (r#"PathValue().contains("api")"#, "a", "/api/v1", true),
      (r#"PathValue().matches("^/api")"#, "a", "/api/v1", true),
      (r#"PathValue().matches("^/api")"#, "a", "/other", false),
      (r#"size(PathValue()) > 0"#, "a", "/x", true),
      (r#"string(PathValue()) == "/x""#, "a", "/x", true),
    ];

    for (rule, host, path, expected) in cases {
      let program = Program::compile(rule).expect("rule should compile");
      assert!(
        build::<(&'static str, &'static str)>(program.expression()).is_none(),
        "expected no pre-filter for non-optimizable rule: {rule}"
      );
      assert_eq!(run_cel(rule, host, path), *expected, "CEL mismatch: {rule} {host} {path}");
    }
  }
}
