pub fn to_napi_error(err: impl std::fmt::Display) -> napi::Error {
  napi::Error::from_reason(err.to_string())
}

pub fn mutex_poisoned(name: &'static str) -> napi::Error {
  napi::Error::from_reason(format!("{name} mutex poisoned"))
}
