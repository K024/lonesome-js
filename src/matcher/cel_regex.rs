use std::sync::{Arc, OnceLock};

use dashmap::DashMap;
use regex::Regex;

type RegexMap = DashMap<String, Arc<Regex>>;

fn global_cache() -> &'static RegexMap {
  static CACHE: OnceLock<RegexMap> = OnceLock::new();
  CACHE.get_or_init(DashMap::new)
}

pub fn compile_cached(pattern: &str) -> Result<Arc<Regex>, regex::Error> {
  if let Some(hit) = global_cache().get(pattern) {
    return Ok(Arc::clone(hit.value()));
  }

  let compiled = Arc::new(Regex::new(pattern)?);
  match global_cache().entry(pattern.to_string()) {
    dashmap::mapref::entry::Entry::Occupied(entry) => Ok(Arc::clone(entry.get())),
    dashmap::mapref::entry::Entry::Vacant(entry) => {
      entry.insert(Arc::clone(&compiled));
      Ok(compiled)
    }
  }
}

pub fn is_match(pattern: &str, input: &str) -> bool {
  compile_cached(pattern)
    .map(|regex| regex.is_match(input))
    .unwrap_or(false)
}

pub fn replace(pattern: &str, input: &str, replacement: &str) -> Option<String> {
  let regex = compile_cached(pattern).ok()?;
  if !regex.is_match(input) {
    return None;
  }
  Some(regex.replace(input, replacement).into_owned())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn is_match_basic() {
    assert!(is_match("^/api", "/api/v1"));
    assert!(!is_match("^/api", "/other"));
    assert!(is_match("[0-9]+", "abc123"));
  }

  #[test]
  fn is_match_invalid_pattern_is_false() {
    assert!(!is_match("(unclosed", "anything"));
  }

  #[test]
  fn replace_replaces_first_match() {
    assert_eq!(
      replace("^/old", "/old/path", "/new").as_deref(),
      Some("/new/path")
    );
  }

  #[test]
  fn replace_no_match_returns_none() {
    assert_eq!(replace("^/old", "/other/path", "/new"), None);
  }

  #[test]
  fn compiled_patterns_are_cached() {
    let a = compile_cached("^/api").expect("pattern compiles");
    let b = compile_cached("^/api").expect("pattern compiles");
    assert!(
      Arc::ptr_eq(&a, &b),
      "repeated compile should reuse the cache entry"
    );
  }

  #[test]
  fn compile_error_surfaces_and_is_cached_absent() {
    assert!(compile_cached("(unclosed").is_err());
    assert!(!is_match("(unclosed", "x"));
    assert_eq!(replace("(unclosed", "x", "y"), None);
  }
}
