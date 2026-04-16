use std::collections::VecDeque;
use std::fmt;
use std::io::{Error, ErrorKind};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use pingora::protocols::l4::virt::{VirtualSockOpt, VirtualSocket};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

struct ReadState {
  pending: VecDeque<(Vec<u8>, usize)>,
  eof: bool,
  err: Option<String>,
  waker: Option<Waker>,
}

impl ReadState {
  fn new() -> Self {
    Self {
      pending: VecDeque::new(),
      eof: false,
      err: None,
      waker: None,
    }
  }
}

pub trait VirtualJsSink: Send + Sync {
  fn on_write(&self, conn_id: &str, data: &[u8]) -> Result<(), String>;
  fn on_close(&self, conn_id: &str) -> Result<(), String>;
}

pub struct VirtualJsSocketState {
  read: Mutex<ReadState>,
  closed: AtomicBool,
}

impl VirtualJsSocketState {
  pub fn new() -> Arc<Self> {
    Arc::new(Self {
      read: Mutex::new(ReadState::new()),
      closed: AtomicBool::new(false),
    })
  }

  pub fn push_data(&self, _conn_id: &str, data: Vec<u8>) -> Result<(), String> {
    if self.closed.load(Ordering::Relaxed) {
      return Err("socket already closed".to_string());
    }

    let mut state = self
      .read
      .lock()
      .map_err(|_| "socket read mutex poisoned".to_string())?;

    if state.eof {
      return Err("socket already eof".to_string());
    }

    if state.err.is_some() {
      return Err("socket already in error state".to_string());
    }

    state.pending.push_back((data, 0));
    if let Some(waker) = state.waker.take() {
      waker.wake();
    }
    Ok(())
  }

  pub fn push_eof(&self, _conn_id: &str) -> Result<(), String> {
    if self.closed.load(Ordering::Relaxed) {
      return Ok(());
    }

    let mut state = self
      .read
      .lock()
      .map_err(|_| "socket read mutex poisoned".to_string())?;
    state.eof = true;
    if let Some(waker) = state.waker.take() {
      waker.wake();
    }
    Ok(())
  }

  pub fn push_error(&self, _conn_id: &str, message: String) -> Result<(), String> {
    if self.closed.load(Ordering::Relaxed) {
      return Ok(());
    }

    let mut state = self
      .read
      .lock()
      .map_err(|_| "socket read mutex poisoned".to_string())?;
    state.err = Some(message);
    if let Some(waker) = state.waker.take() {
      waker.wake();
    }
    Ok(())
  }
}

pub struct VirtualJsSocket {
  conn_id: String,
  state: Arc<VirtualJsSocketState>,
  sink: Arc<dyn VirtualJsSink>,
}

impl fmt::Debug for VirtualJsSocket {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.debug_struct("VirtualJsSocket")
      .field("conn_id", &self.conn_id)
      .finish()
  }
}

impl VirtualJsSocket {
  pub fn new(
    conn_id: String,
    state: Arc<VirtualJsSocketState>,
    sink: Arc<dyn VirtualJsSink>,
  ) -> Self {
    Self {
      conn_id,
      state,
      sink,
    }
  }
}

impl AsyncRead for VirtualJsSocket {
  fn poll_read(
    self: Pin<&mut Self>,
    cx: &mut Context<'_>,
    buf: &mut ReadBuf<'_>,
  ) -> Poll<std::io::Result<()>> {
    let mut read = match self.state.read.lock() {
      Ok(v) => v,
      Err(_) => return Poll::Ready(Err(Error::other("socket read mutex poisoned"))),
    };

    if let Some(message) = read.err.take() {
      self.state.closed.store(true, Ordering::Relaxed);
      return Poll::Ready(Err(Error::other(message)));
    }

    while buf.remaining() > 0 {
      let Some((chunk, offset)) = read.pending.pop_front() else {
        break;
      };

      let chunk_ref = chunk.as_slice();
      let remain = chunk_ref.len().saturating_sub(offset);
      if remain == 0 {
        continue;
      }

      let to_copy = remain.min(buf.remaining());
      let end = offset + to_copy;
      buf.put_slice(&chunk_ref[offset..end]);
      if end < chunk_ref.len() {
        read.pending.push_front((chunk, end));
        break;
      }
    }

    if buf.filled().is_empty() {
      if read.eof {
        self.state.closed.store(true, Ordering::Relaxed);
        return Poll::Ready(Ok(()));
      }

      read.waker = Some(cx.waker().clone());
      return Poll::Pending;
    }

    Poll::Ready(Ok(()))
  }
}

impl AsyncWrite for VirtualJsSocket {
  fn poll_write(
    self: Pin<&mut Self>,
    _cx: &mut Context<'_>,
    buf: &[u8],
  ) -> Poll<std::io::Result<usize>> {
    if self.state.closed.load(Ordering::Relaxed) {
      return Poll::Ready(Err(Error::new(ErrorKind::BrokenPipe, "socket closed")));
    }

    self
      .sink
      .on_write(&self.conn_id, buf)
      .map_err(Error::other)?;

    Poll::Ready(Ok(buf.len()))
  }

  fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
    Poll::Ready(Ok(()))
  }

  fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
    self.state.closed.store(true, Ordering::Relaxed);
    self.sink.on_close(&self.conn_id).map_err(Error::other)?;
    Poll::Ready(Ok(()))
  }
}

impl VirtualSocket for VirtualJsSocket {
  fn set_socket_option(&self, _opt: VirtualSockOpt) -> std::io::Result<()> {
    Ok(())
  }
}
