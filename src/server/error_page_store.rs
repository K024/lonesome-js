use std::str::FromStr;
use std::sync::Arc;

use arc_swap::ArcSwap;
use cel::Program;
use http::header::{HeaderName, HeaderValue};

/// One error page entry: which generated error statuses it serves (or any), an
/// optional CEL matcher that gates it, and the response content to render.
pub struct ErrorPageEntry {
  pub id: String,
  /// Served statuses (each in `400..=599`); empty = any generated error status.
  pub statuses: Vec<u16>,
  /// Compiled CEL rule; `None` = unconditional. Evaluated against the request
  /// session (HostValue, PathValue, ClientIP, ErrorStatusValue, ...).
  pub matcher: Option<Program>,
  /// Static body; mutually exclusive with `body_program`.
  pub body: Option<String>,
  /// Compiled CEL body expression; mutually exclusive with `body`.
  pub body_program: Option<Program>,
  pub content_type: Option<String>,
  pub headers: Vec<(HeaderName, HeaderValue)>,
  /// Serve with a different status than the generated one.
  pub status_override: Option<u16>,
  /// Higher priority first; ties keep insertion order.
  pub priority: i32,
}

/// Validated configuration accepted by [`ErrorPageStore::update`].
pub struct ErrorPageConfig {
  pub id: String,
  /// Status spec: `None` (any status) or a comma-separated list of codes and
  /// ranges, e.g. `"400-403,418,500"` or `"404"`.
  pub status: Option<String>,
  pub matcher: Option<String>,
  pub body: Option<String>,
  pub body_expression: Option<String>,
  pub content_type: Option<String>,
  pub headers: Vec<(String, String)>,
  pub status_override: Option<u16>,
  pub priority: i32,
}

/// Parses a status spec such as `"400-403,418,500"` into the set of statuses.
/// Each code must be within `400..=599`.
pub fn parse_status_spec(spec: &str) -> Result<Vec<u16>, String> {
  if spec.trim().is_empty() {
    return Ok(Vec::new());
  }

  let mut statuses = Vec::new();
  for token in spec.split(',') {
    let token = token.trim();
    if token.is_empty() {
      return Err(format!(
        "invalid error page status spec '{spec}': empty segment"
      ));
    }

    let (start, end) = if let Some((a, b)) = token.split_once('-') {
      let a = a.trim();
      let b = b.trim();
      if a.is_empty() || b.is_empty() {
        return Err(format!(
          "invalid error page status spec '{spec}': bad range '{token}'"
        ));
      }
      let a: u16 = a
        .parse()
        .map_err(|_| format!("invalid error page status spec '{spec}': bad code '{a}'"))?;
      let b: u16 = b
        .parse()
        .map_err(|_| format!("invalid error page status spec '{spec}': bad code '{b}'"))?;
      if a > b {
        return Err(format!(
          "invalid error page status spec '{spec}': range '{token}' is reversed"
        ));
      }
      (a, b)
    } else {
      let code: u16 = token
        .parse()
        .map_err(|_| format!("invalid error page status spec '{spec}': bad code '{token}'"))?;
      (code, code)
    };

    for code in start..=end {
      if !(400..=599).contains(&code) {
        return Err(format!(
          "error page status must be within [400, 599], got {code} in spec '{spec}'"
        ));
      }
      if !statuses.contains(&code) {
        statuses.push(code);
      }
    }
  }

  Ok(statuses)
}

impl ErrorPageConfig {
  pub fn build(self) -> Result<ErrorPageEntry, String> {
    if self.id.trim().is_empty() {
      return Err("error page id cannot be empty".to_string());
    }

    let statuses = match self.status.as_deref() {
      Some(spec) => parse_status_spec(spec)?,
      None => Vec::new(), // any status
    };

    if let Some(status) = self.status_override {
      if !(100..=999).contains(&status) {
        return Err(format!(
          "error page status_override must be within [100, 999], got {status}"
        ));
      }
    }

    if self.body.is_some() && self.body_expression.is_some() {
      return Err("error page body and body_expression cannot both be set".to_string());
    }

    let matcher = self
      .matcher
      .as_deref()
      .map(|rule| {
        Program::compile(rule)
          .map_err(|e| format!("failed to compile error page matcher '{rule}': {e}"))
      })
      .transpose()?;

    let body_program = self
      .body_expression
      .as_deref()
      .map(|expr| {
        Program::compile(expr)
          .map_err(|e| format!("failed to compile error page body_expression '{expr}': {e}"))
      })
      .transpose()?;

    let headers = self
      .headers
      .into_iter()
      .map(|(name, value)| {
        let name = HeaderName::from_str(&name)
          .map_err(|e| format!("invalid error page header name '{name}': {e}"))?;
        let value = HeaderValue::from_str(&value)
          .map_err(|e| format!("invalid error page header value for '{name}': {e}"))?;
        Ok((name, value))
      })
      .collect::<Result<Vec<_>, String>>()?;

    Ok(ErrorPageEntry {
      id: self.id,
      statuses,
      matcher,
      body: self.body,
      body_program,
      content_type: self.content_type,
      headers,
      status_override: self.status_override,
      priority: self.priority,
    })
  }
}

/// Runtime error page store, keyed by id and consulted whenever a generated
/// error response (>= 400) is about to be written. Entries are ordered by
/// priority (descending, insertion order on ties); the first whose status
/// applies and whose matcher (if any) matches wins.
///
/// Read-heavy / write-rare: lookups are lock-free `ArcSwap` snapshots, and an
/// update clones the entry list once under a single atomic store, so the hot
/// error path never blocks on writers.
pub struct ErrorPageStore {
  inner: ArcSwap<Vec<Arc<ErrorPageEntry>>>,
}

impl Default for ErrorPageStore {
  fn default() -> Self {
    Self::new()
  }
}

impl ErrorPageStore {
  pub fn new() -> Self {
    Self {
      inner: ArcSwap::from_pointee(Vec::new()),
    }
  }

  /// Register or replace an error page entry by id. CEL matcher and body
  /// expression are compiled here; invalid config is rejected immediately.
  pub fn update(&self, config: ErrorPageConfig) -> Result<(), String> {
    let entry = Arc::new(config.build()?);

    let mut entries = (*self.inner.load_full()).clone();
    entries.retain(|e| e.id != entry.id);
    entries.push(entry);
    // stable sort: equal priorities keep insertion order
    entries.sort_by(|a, b| b.priority.cmp(&a.priority));
    self.inner.store(Arc::new(entries));
    Ok(())
  }

  pub fn remove(&self, id: &str) -> bool {
    let mut entries = (*self.inner.load_full()).clone();
    let before = entries.len();
    entries.retain(|e| e.id != id);
    let removed = before != entries.len();
    if removed {
      self.inner.store(Arc::new(entries));
    }
    removed
  }

  pub fn len(&self) -> usize {
    self.inner.load_full().len()
  }

  pub fn is_empty(&self) -> bool {
    self.inner.load_full().is_empty()
  }

  /// Snapshot of all entries in lookup order (priority desc, insertion order).
  pub fn snapshot(&self) -> Vec<Arc<ErrorPageEntry>> {
    (*self.inner.load_full()).clone()
  }
}
