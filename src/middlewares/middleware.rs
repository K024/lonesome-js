use async_trait::async_trait;
use pingora::http::{RequestHeader, ResponseHeader};
use pingora::protocols::Digest;
use pingora::proxy::{FailToProxy, Session};
use pingora::upstreams::peer::HttpPeer;
use pingora::{Error, ErrorType, Result};

use crate::proxy::ctx::ProxyCtx;

pub(crate) fn middleware_internal_error(
  context: &'static str,
  message: impl Into<String>,
) -> Box<Error> {
  Error::because(
    ErrorType::InternalError,
    context,
    std::io::Error::other(message.into()),
  )
}

#[async_trait]
pub trait Middleware: Send + Sync {
  // First phase for each request. Runs before main proxy logic.
  async fn early_request_filter(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
  ) -> Result<()> {
    Ok(())
  }

  // Main request phase. Returning Ok(true) means request was handled and should short-circuit.
  async fn request_filter(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
  ) -> Result<bool> {
    Ok(false)
  }

  // // Called for each downstream request body chunk before sending to upstream.
  // async fn request_body_filter(
  //   &self,
  //   _proxy_ctx: &mut ProxyCtx,
  //   _session: &mut Session,
  //   _body: &mut Option<Bytes>,
  //   _end_of_stream: bool,
  // ) -> Result<()> {
  //   Ok(())
  // }

  // Controls whether proxying to upstream should continue. Returning false stops upstream flow.
  async fn proxy_upstream_filter(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
  ) -> Result<bool> {
    Ok(true)
  }

  // Mutate request header right before it is sent to upstream.
  async fn upstream_request_filter(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _upstream_request: &mut RequestHeader,
  ) -> Result<()> {
    Ok(())
  }

  // Called after successful upstream connection setup.
  async fn connected_to_upstream(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _reused: bool,
    _peer: &HttpPeer,
    _digest: Option<&Digest>,
  ) -> Result<()> {
    Ok(())
  }

  // Called when connecting to upstream fails; may transform error for retry policy.
  fn fail_to_connect(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _peer: &HttpPeer,
    error: Box<Error>,
  ) -> Result<Box<Error>> {
    Ok(error)
  }

  // Upstream response header phase (before downstream response filters/caching integration points).
  async fn upstream_response_filter(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _upstream_response: &mut ResponseHeader,
  ) -> Result<()> {
    Ok(())
  }

  // // Upstream response body chunk phase.
  // fn upstream_response_body_filter(
  //   &self,
  //   _proxy_ctx: &mut ProxyCtx,
  //   _session: &mut Session,
  //   _body: &mut Option<Bytes>,
  //   _end_of_stream: bool,
  // ) -> Result<Option<Duration>> {
  //   Ok(None)
  // }

  // // Upstream response trailer phase.
  // fn upstream_response_trailer_filter(
  //   &self,
  //   _proxy_ctx: &mut ProxyCtx,
  //   _session: &mut Session,
  //   _upstream_trailers: &mut HMap,
  // ) -> Result<()> {
  //   Ok(())
  // }

  // Final response header phase before sending to downstream.
  async fn response_filter(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _upstream_response: &mut ResponseHeader,
  ) -> Result<()> {
    Ok(())
  }

  // // Final response body chunk phase before sending to downstream.
  // fn response_body_filter(
  //   &self,
  //   _proxy_ctx: &mut ProxyCtx,
  //   _session: &mut Session,
  //   _body: &mut Option<Bytes>,
  //   _end_of_stream: bool,
  // ) -> Result<Option<Duration>> {
  //   Ok(None)
  // }

  // // Final response trailer phase before sending to downstream.
  // async fn response_trailer_filter(
  //   &self,
  //   _proxy_ctx: &mut ProxyCtx,
  //   _session: &mut Session,
  //   _upstream_trailers: &mut HMap,
  // ) -> Result<Option<Bytes>> {
  //   Ok(None)
  // }

  // Called on proxy IO errors after connection is established; may mutate retry behavior.
  fn error_while_proxy(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _peer: &HttpPeer,
    error: Box<Error>,
    _client_reused: bool,
  ) -> Result<Box<Error>> {
    Ok(error)
  }

  // Terminal error phase for custom downstream error response behavior.
  async fn fail_to_proxy(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _error: &Error,
  ) -> Result<Option<FailToProxy>> {
    Ok(None)
  }

  // Last phase for cleanup/metrics/logging; runs after request completion or error.
  async fn logging(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _error: Option<&Error>,
  ) -> Result<()> {
    Ok(())
  }
}
