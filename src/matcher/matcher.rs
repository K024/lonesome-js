use cel::{Program, Value};
use pingora::proxy::Session;

use crate::proxy::ctx::ProxyCtx;

use super::cel_session_context::{ensure_session_cel_context, CelHttpSession};
use super::precheck::{build, CheapExpr, Tri};

pub struct Matcher {
  source: String,
  program: Program,
  precheck: Option<CheapExpr<CelHttpSession>>,
}

impl Matcher {
  pub fn from_cel(source: String) -> Result<Self, String> {
    let program = Program::compile(&source)
      .map_err(|e| format!("failed to compile matcher CEL '{source}': {e}"))?;
    let precheck = build(program.expression());
    Ok(Self {
      source,
      program,
      precheck,
    })
  }

  pub fn source(&self) -> &str {
    &self.source
  }

  pub fn matches(&self, session: &Session, proxy_ctx: &mut ProxyCtx) -> bool {
    let data = ensure_session_cel_context(session, proxy_ctx);

    if let Some(expr) = &self.precheck {
      match expr.eval(data.cel_http_session.as_ref()) {
        Tri::False => return false,
        Tri::True => return true,
        Tri::Unknown => {}
      }
    }

    match self.program.execute(data.cel_ctx.as_ref()) {
      Ok(Value::Bool(v)) => v,
      Ok(other) => {
        eprintln!("matcher '{}' returned non-bool: {other:?}", self.source);
        false
      }
      Err(e) => {
        eprintln!("matcher '{}' execute error: {e}", self.source);
        false
      }
    }
  }
}
