use std::collections::HashMap;
use std::hash::{DefaultHasher, Hasher};
use std::sync::{Arc, OnceLock, RwLock};

use pingora_lru::Lru;
use regex::Regex;

const REGEX_CACHE_CAPACITY: usize = 64;
const REGEX_CACHE_SHARDS: usize = 16;

struct CacheState {
  entries: HashMap<String, Arc<Regex>>,
}

struct RegexCache {
  lru: Lru<String, REGEX_CACHE_SHARDS>,
  state: RwLock<CacheState>,
}

impl RegexCache {
  fn new() -> Self {
    Self {
      lru: Lru::with_capacity(REGEX_CACHE_CAPACITY, REGEX_CACHE_CAPACITY),
      state: RwLock::new(CacheState {
        entries: HashMap::new(),
      }),
    }
  }

  fn key(pattern: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    hasher.write(pattern.as_bytes());
    hasher.finish()
  }

  fn get(&self, pattern: &str) -> Option<Arc<Regex>> {
    let hit = self
      .state
      .read()
      .expect("regex cache state rwlock poisoned")
      .entries
      .get(pattern)
      .cloned();

    if hit.is_some() {
      let key = Self::key(pattern);
      let _ = self.lru.promote(key);
    }

    hit
  }

  fn insert(&self, pattern: &str, regex: Arc<Regex>) -> Arc<Regex> {
    let key = Self::key(pattern);

    {
      let mut state = self
        .state
        .write()
        .expect("regex cache state rwlock poisoned");

      if let Some(existing) = state.entries.get(pattern) {
        return existing.clone();
      }

      state.entries.insert(pattern.to_string(), regex.clone());
    }

    let _ = self.lru.admit(key, pattern.to_string(), 1);
    let evicted = self.lru.evict_to_limit();

    if !evicted.is_empty() {
      let mut state = self
        .state
        .write()
        .expect("regex cache state rwlock poisoned");
      for (evicted_pattern, _) in evicted {
        state.entries.remove(evicted_pattern.as_str());
      }
    }

    regex
  }
}

fn global_cache() -> &'static RegexCache {
  static CACHE: OnceLock<RegexCache> = OnceLock::new();
  CACHE.get_or_init(RegexCache::new)
}

pub fn compile_cached(pattern: &str) -> Result<Arc<Regex>, regex::Error> {
  if let Some(hit) = global_cache().get(pattern) {
    return Ok(hit);
  }

  let compiled = Arc::new(Regex::new(pattern)?);
  Ok(global_cache().insert(pattern, compiled))
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
