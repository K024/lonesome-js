use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use pingora::http::{HMap, RequestHeader, ResponseHeader};
use pingora::protocols::Digest;
use pingora::proxy::{FailToProxy, Session};
use pingora::upstreams::peer::HttpPeer;

use crate::proxy::ctx::ProxyCtx;

#[async_trait]
pub trait Middleware: Send + Sync {
  async fn early_request_filter(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
  ) -> Result<(), String> {
    Ok(())
  }

  async fn request_filter(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
  ) -> Result<bool, String> {
    Ok(false)
  }

  async fn request_body_filter(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _body: &mut Option<Bytes>,
    _end_of_stream: bool,
  ) -> Result<(), String> {
    Ok(())
  }

  async fn proxy_upstream_filter(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
  ) -> Result<bool, String> {
    Ok(true)
  }

  async fn upstream_request_filter(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _upstream_request: &mut RequestHeader,
  ) -> Result<(), String> {
    Ok(())
  }

  async fn connected_to_upstream(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _reused: bool,
    _peer: &HttpPeer,
    _digest: Option<&Digest>,
  ) -> Result<(), String> {
    Ok(())
  }

  fn fail_to_connect(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _peer: &HttpPeer,
    error: Box<pingora::Error>,
  ) -> Result<Box<pingora::Error>, String> {
    Ok(error)
  }

  async fn upstream_response_filter(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _upstream_response: &mut ResponseHeader,
  ) -> Result<(), String> {
    Ok(())
  }

  fn upstream_response_body_filter(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _body: &mut Option<Bytes>,
    _end_of_stream: bool,
  ) -> Result<Option<Duration>, String> {
    Ok(None)
  }

  fn upstream_response_trailer_filter(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _upstream_trailers: &mut HMap,
  ) -> Result<(), String> {
    Ok(())
  }

  async fn response_filter(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _upstream_response: &mut ResponseHeader,
  ) -> Result<(), String> {
    Ok(())
  }

  fn response_body_filter(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _body: &mut Option<Bytes>,
    _end_of_stream: bool,
  ) -> Result<Option<Duration>, String> {
    Ok(None)
  }

  async fn response_trailer_filter(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _upstream_trailers: &mut HMap,
  ) -> Result<Option<Bytes>, String> {
    Ok(None)
  }

  fn error_while_proxy(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _peer: &HttpPeer,
    error: Box<pingora::Error>,
    _client_reused: bool,
  ) -> Result<Box<pingora::Error>, String> {
    Ok(error)
  }

  async fn fail_to_proxy(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _error: &pingora::Error,
  ) -> Result<Option<FailToProxy>, String> {
    Ok(None)
  }

  async fn logging(
    &self,
    _proxy_ctx: &mut ProxyCtx,
    _session: &mut Session,
    _error: Option<&pingora::Error>,
  ) -> Result<(), String> {
    Ok(())
  }
}
