pub mod registry;
pub mod socket;

pub use registry::{
  push_event as virtual_push_event, register_virtual_listener, unregister_virtual_listener,
  virtual_open_connection,
};
