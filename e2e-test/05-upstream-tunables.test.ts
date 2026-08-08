import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createNetServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { startProxy } from './helpers/proxy.js'
import { nextRouteId, withRoute } from './helpers/routes.js'
import { proxyFetch } from './helpers/request.js'
import type { LonesomeServer } from '../dist/index.js'

let server: LonesomeServer
let proxyPort: number
let stall: { port: number; close: () => Promise<void> }

function startStall(): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = createNetServer((socket) => {
    socket.on('data', () => {
      // accept the connection but never reply
    })
    socket.on('error', () => {})
  })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port
      resolve({
        port,
        close: () => new Promise((r) => srv.close(() => r())),
      })
    })
  })
}

before(async () => {
  stall = await startStall()
  ;({ server, port: proxyPort } = await startProxy())
})

after(async () => {
  try {
    server?.stop()
  } catch {
    // ok
  }
  await stall.close()
})

describe('upstream timeouts', () => {
  it('read_timeout_ms aborts a stalled upstream quickly', async () => {
    const clean = withRoute(server, {
      id: nextRouteId('tmo-read'),
      matcher: { rule: "PathPrefix('/tmo/read')", priority: 50 },
      middlewares: [],
      upstreams: [{
        kind: 'tcp',
        address: `127.0.0.1:${stall.port}`,
        tls: false,
        sni: '',
        weight: 1,
        readTimeoutMs: 300,
      }],
    })

    const t0 = Date.now()
    let status = 0
    try {
      const res = await proxyFetch(proxyPort, '/tmo/read/item')
      status = res.status
      await res.text().catch(() => {})
    } catch {
      status = 0
    }
    const elapsed = Date.now() - t0

    assert.notStrictEqual(status, 200, `expected a timeout failure, got ${status}`)
    assert.ok(elapsed < 5000, `expected a fast timeout, took ${elapsed}ms`)
    clean()
  })

  it('connect_timeout_ms aborts an unreachable upstream quickly', async () => {
    const clean = withRoute(server, {
      id: nextRouteId('tmo-conn'),
      matcher: { rule: "PathPrefix('/tmo/conn')", priority: 50 },
      middlewares: [],
      upstreams: [{
        kind: 'tcp',
        address: '192.0.2.1:80',
        tls: false,
        sni: '',
        weight: 1,
        connectTimeoutMs: 300,
      }],
    })

    const t0 = Date.now()
    let status = 0
    try {
      const res = await proxyFetch(proxyPort, '/tmo/conn/item')
      status = res.status
      await res.text().catch(() => {})
    } catch {
      status = 0
    }
    const elapsed = Date.now() - t0

    assert.notStrictEqual(status, 200, `expected a connect failure, got ${status}`)
    assert.ok(elapsed < 5000, `expected a fast connect timeout, took ${elapsed}ms`)
    clean()
  })

  it('rejects a zero timeout at validation', () => {
    assert.throws(
      () => {
        server.validate({
          id: nextRouteId('tmo-zero'),
          matcher: { rule: "PathPrefix('/tmo/zero')", priority: 50 },
          middlewares: [],
          upstreams: [{
            kind: 'tcp',
            address: '127.0.0.1:1',
            tls: false,
            sni: '',
            weight: 1,
            readTimeoutMs: 0,
          }],
        })
      },
      /read_timeout_ms/,
    )
  })
})
