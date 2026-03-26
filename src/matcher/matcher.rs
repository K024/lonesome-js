use cel::{Program, Value};
use pingora::proxy::Session;

use crate::proxy::ctx::ProxyCtx;

use super::cel_session_context::ensure_context;

pub struct Matcher {
  source: String,
  program: Program,
}

impl Matcher {
  pub fn from_cel(source: String) -> Result<Self, String> {
    let program = Program::compile(&source)
      .map_err(|e| format!("failed to compile matcher CEL '{source}': {e}"))?;
    Ok(Self { source, program })
  }

  pub fn source(&self) -> &str {
    &self.source
  }

  pub fn matches(&self, session: &Session, proxy_ctx: &mut ProxyCtx) -> bool {
    let ctx = ensure_context(session, proxy_ctx);
    match self.program.execute(ctx) {
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
