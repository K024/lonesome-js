use std::sync::{Arc, OnceLock};

use cel::objects::Key;
use cel::{Context, FunctionContext, Value};

fn get_string_var(ftx: &FunctionContext, name: &str) -> Option<String> {
  let val = ftx.ptx.get_variable(name)?;
  match Value::try_from(val.as_ref()) {
    Ok(Value::String(v)) => Some((*v).clone()),
    _ => None,
  }
}

fn extract_name_value(item: &Value) -> Option<(&str, &str)> {
  let Value::Map(map) = item else {
    return None;
  };

  let mut name_out = None;
  let mut value_out = None;

  for (k, v) in map.map.iter() {
    let (Key::String(k), Value::String(v)) = (k, v) else {
      continue;
    };

    if k.as_str() == "name" {
      name_out = Some(v.as_str());
    } else if k.as_str() == "value" {
      value_out = Some(v.as_str());
    }
  }

  match (name_out, value_out) {
    (Some(name), Some(value)) => Some((name, value)),
    _ => None,
  }
}

fn contains_kv_from_list_var(
  ftx: &FunctionContext,
  var_name: &str,
  key: &str,
  value: &str,
  key_ignore_ascii_case: bool,
) -> bool {
  let Some(val) = ftx.ptx.get_variable(var_name) else {
    return false;
  };

  let Ok(Value::List(list)) = Value::try_from(val.as_ref()) else {
    return false;
  };

  for item in list.iter() {
    let Some((name, actual_value)) = extract_name_value(item) else {
      continue;
    };

    let key_match = if key_ignore_ascii_case {
      name.eq_ignore_ascii_case(key)
    } else {
      name == key
    };

    if key_match && actual_value == value {
      return true;
    }
  }

  false
}

fn host(ftx: &FunctionContext, expected: Arc<String>) -> bool {
  get_string_var(ftx, "host")
    .map(|v| v == expected.as_str())
    .unwrap_or(false)
}

fn method(ftx: &FunctionContext, expected: Arc<String>) -> bool {
  get_string_var(ftx, "method")
    .map(|v| v == expected.as_str())
    .unwrap_or(false)
}

fn path(ftx: &FunctionContext, expected: Arc<String>) -> bool {
  get_string_var(ftx, "path")
    .map(|v| v == expected.as_str())
    .unwrap_or(false)
}

fn path_prefix(ftx: &FunctionContext, prefix: Arc<String>) -> bool {
  get_string_var(ftx, "path")
    .map(|v| v.starts_with(prefix.as_str()))
    .unwrap_or(false)
}

fn client_ip(ftx: &FunctionContext, ip: Arc<String>) -> bool {
  get_string_var(ftx, "clientIP")
    .map(|v| v == ip.as_str())
    .unwrap_or(false)
}

fn header(ftx: &FunctionContext, key: Arc<String>, value: Arc<String>) -> bool {
  contains_kv_from_list_var(ftx, "headers", &key, &value, true)
}

fn query(ftx: &FunctionContext, key: Arc<String>, value: Arc<String>) -> bool {
  contains_kv_from_list_var(ftx, "query", &key, &value, false)
}

pub fn parent_context() -> &'static Context<'static> {
  static PARENT: OnceLock<Context<'static>> = OnceLock::new();

  PARENT.get_or_init(|| {
    let mut ctx = Context::default();
    ctx.add_function("Host", host);
    ctx.add_function("Method", method);
    ctx.add_function("Path", path);
    ctx.add_function("PathPrefix", path_prefix);
    ctx.add_function("Header", header);
    ctx.add_function("Query", query);
    ctx.add_function("ClientIP", client_ip);
    ctx
  })
}
