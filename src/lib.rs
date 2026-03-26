#![deny(clippy::all)]

pub mod bindings;
pub mod config;
pub mod matcher;
pub mod middlewares;
pub mod proxy;
pub mod route;
pub mod server;
pub mod upstream;

use napi_derive::napi;

pub use bindings::server::DenaliServer;

#[napi]
pub fn plus_100(input: u32) -> u32 {
  input + 100
}
