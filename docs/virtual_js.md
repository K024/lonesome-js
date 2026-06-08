# `virtual_js` Upstreams

`virtual_js` is an in-process upstream mode that bridges Pingora L4 streams into JavaScript handlers through N-API callbacks.

## What It Solves

`virtual_js` lets a route forward to a JavaScript backend without dialing an external TCP address.

Typical use cases:
- In-process adapters for internal protocols
- Mock backends for integration tests
- Custom programmable handlers that should not expose network ports

## Upstream Configuration

Use `kind: 'virtual_js'` and set `address` to a listener key.

```ts
upstreams: [
  { kind: 'virtual_js', address: 'my-vjs-key', tls: false, sni: '', weight: 1 },
]
```

Notes:
- `address` is not a host:port. It is the virtual listener key.
- Empty key is rejected.
- `h2c` is supported for non-TLS HTTP/2 behavior.

## JS API Surface

Exports:

```ts
registerVirtualListener(key: string, onEvent: (kind: string, connId: string, data: Buffer) => void): void
unregisterVirtualListener(key: string): boolean
virtualPushEvent(kind: string, connId: string, data?: Buffer, message?: string): void
```

Event kinds from Rust to JS listener:
- `open`: a new virtual connection is created
- `write`: upstream wrote bytes toward JS side
- `close`: upstream closed the connection

Push event kinds from JS to Rust socket:
- `data`: deliver bytes to Rust reader
- `eof`: signal stream end
- `error`: signal stream error with `message`

## Bridge Lifecycle

1. A request selects a `virtual_js` upstream endpoint.
2. Rust resolves listener by key and allocates a `connId` and socket state.
3. Rust emits `open` to JS listener.
4. JS creates/attaches a duplex and emits HTTP `connection` to a Node server.
5. Data flows both ways:
   - Rust write -> JS `write` event
   - JS duplex write -> `virtualPushEvent('data', connId, chunk)`
6. Close flow:
   - Rust shutdown -> JS `close` event
   - JS side can also send `eof` or `error`

Interceptor middleware has been split into [interceptor.md](./interceptor.md).

## Minimal Listener Pattern

```ts
import { createServer } from 'node:http'
import { Duplex } from 'node:stream'
import { registerVirtualListener, unregisterVirtualListener, virtualPushEvent } from 'lonesome-js'

class VirtualSocketDuplex extends Duplex {
  constructor(connId: string) {
    super()
    this.connId = connId
    ;(this as any).remoteAddress = '127.0.0.1'
    ;(this as any).remotePort = 0
    ;(this as any).localAddress = '127.0.0.1'
    ;(this as any).localPort = 0
    ;(this as any).encrypted = false
  }

  private connId: string

  _read(): void {}

  _write(chunk: Buffer, _encoding: BufferEncoding, cb: (err?: Error | null) => void): void {
    try {
      virtualPushEvent('data', this.connId, chunk)
      cb()
    } catch (err) {
      cb(err as Error)
    }
  }

  _final(cb: (err?: Error | null) => void): void {
    try {
      virtualPushEvent('eof', this.connId)
      cb()
    } catch (err) {
      cb(err as Error)
    }
  }
}

const httpServer = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ method: req.method, url: req.url }))
})

const connMap = new Map<string, VirtualSocketDuplex>()

registerVirtualListener('my-vjs-key', (kind, connId, data) => {
  if (kind === 'open') {
    const duplex = new VirtualSocketDuplex(connId)
    connMap.set(connId, duplex)
    duplex.on('close', () => connMap.delete(connId))
    httpServer.emit('connection', duplex)
    return
  }

  if (kind === 'write') {
    connMap.get(connId)?.push(data)
    return
  }

  if (kind === 'close') {
    const duplex = connMap.get(connId)
    if (!duplex) return
    duplex.push(null)
    duplex.end()
    connMap.delete(connId)
  }
})

// later
unregisterVirtualListener('my-vjs-key')
httpServer.close()
```

## Load Balancing with `virtual_js`

`virtual_js` endpoints can participate in normal upstream load balancing.

```ts
upstreams: [
  { kind: 'virtual_js', address: 'vjs-a', tls: false, sni: '', weight: 1 },
  { kind: 'virtual_js', address: 'vjs-b', tls: false, sni: '', weight: 2 },
],
loadBalancer: { algorithm: 'round_robin', maxIterations: 16 }
```

Behavior:
- Works with `round_robin` and `consistent_hash` selection logic.
- Weight is honored through backend metadata.

## Connection Reuse

`virtual_js` currently opens a fresh virtual upstream connection for each request. The implementation sets the Pingora peer idle timeout to `0` to keep these streams out of the connection pool.

This is intentional with Pingora 0.8.x: `VirtualSocketStream` has no real OS fd/socket, so Pingora reports `-1` on Unix (and `INVALID_SOCKET` on Windows). Pingora's reusable-stream path still checks idle streams with `peer.matches_fd()` / `peer.matches_sock()` before testing whether the stream is reusable, so virtual streams cannot pass the current validation. This matches the upstream tracking issue [cloudflare/pingora#883](https://github.com/cloudflare/pingora/issues/883). If Pingora adds a virtual-stream-aware reuse check later, this can be revisited.

There is an e2e test (`07-virtual-js-reuse.test.ts`) that asserts two sequential requests produce two distinct virtual `open` events.

## Failure Modes

- Missing listener key at connect time causes upstream connect failure.
- Interceptor middleware is documented separately in `interceptor.md`.
- Duplicate listener registration for the same key is rejected.
- Pushing events to unknown `connId` returns error.
- Unsupported `virtualPushEvent` kind returns error.

If a listener is unregistered while routes still target its key, requests to those routes fail (for example, 502 from proxy layer).
