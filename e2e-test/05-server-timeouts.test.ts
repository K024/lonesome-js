import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { LonesomeServer } from '../dist/index.js'
import type { LonesomeServer as LonesomeServerType } from '../dist/index.js'
import { createDynamicUpstream } from './helpers/upstream.js'
import { nextRouteId, withRoute } from './helpers/routes.js'
import { proxyFetch } from './helpers/request.js'
import { pickFreePort, sleep } from './helpers/proxy.js'

describe('downstream timeouts', () => {
  let server: LonesomeServerType
  let port: number
  let upstream: ReturnType<typeof createDynamicUpstream>

  before(async () => {
    upstream = createDynamicUpstream()
    await upstream.start()
    port = await pickFreePort()
    server = new LonesomeServer()
    server.start({
      listeners: [{ kind: 'tcp', addr: `127.0.0.1:${port}` }],
      downstreamReadTimeoutMs: 3000,
      downstreamWriteTimeoutMs: 3000,
    })
    await sleep(600)

    withRoute(server, {
      id: nextRouteId('tmo-ds'),
      matcher: { rule: "PathPrefix('/slow')", priority: 50 },
      middlewares: [],
      upstreams: [{
        kind: 'tcp',
        address: `127.0.0.1:${upstream.port}`,
        tls: false,
        sni: '',
        weight: 1,
      }],
    })
  })

  after(async () => {
    try {
      server?.stop()
    } catch {
      // ok
    }
    await upstream?.stop()
  })

  it('accepts the timeouts and serves traffic normally', async () => {
    const res = await proxyFetch(port, '/slow/ok')
    await res.text()
    assert.strictEqual(res.status, 200)
  })

  it('rejects a zero timeout at validation', () => {
    const s = new LonesomeServer()
    assert.throws(
      () => s.start({
        listeners: [{ kind: 'tcp', addr: '127.0.0.1:1' }],
        downstreamReadTimeoutMs: 0,
      }),
      /downstreamReadTimeoutMs/,
    )
    assert.throws(
      () => s.start({
        listeners: [{ kind: 'tcp', addr: '127.0.0.1:1' }],
        downstreamWriteTimeoutMs: 0,
      }),
      /downstreamWriteTimeoutMs/,
    )
  })
})
