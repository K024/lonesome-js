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
