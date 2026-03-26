pub mod add_header;
pub mod middleware;
pub mod registry;
pub mod remove_header;

pub use add_header::{AddHeaderConfig, AddHeaderMiddleware};
pub use middleware::Middleware;
pub use remove_header::{RemoveHeaderConfig, RemoveHeaderMiddleware};

#[derive(Clone, Debug)]
pub enum MiddlewareType {
  AddHeader(AddHeaderConfig),
  RemoveHeader(RemoveHeaderConfig),
}
