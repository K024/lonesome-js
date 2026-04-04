import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startProxy } from './helpers/proxy.js'
import { createDynamicUpstream } from './helpers/upstream.js'
import { nextRouteId, tcpUpstream, withRoute } from './helpers/routes.js'
import { proxyFetch } from './helpers/request.js'
import type { LonesomeServer, UpstreamConfig } from '../dist/index.js'

let server: LonesomeServer
let proxyPort: number
const upstream1 = createDynamicUpstream()
const upstream2 = createDynamicUpstream()
const cleanups: Array<() => void> = []

before(async () => {
  await upstream1.start()
  await upstream2.start()
  ;({ server, port: proxyPort } = await startProxy())
})

after(async () => {
  cleanups.forEach((fn) => fn())
  server.stop()
  await upstream1.stop()
  await upstream2.stop()
})

function bothUpstreams(): UpstreamConfig[] {
  return [
    { kind: 'tcp', address: `127.0.0.1:${upstream1.port}`, tls: false, sni: '', weight: 1 },
    { kind: 'tcp', address: `127.0.0.1:${upstream2.port}`, tls: false, sni: '', weight: 1 },
  ]
}

describe('middleware: health_check', () => {
  describe('healthy upstream', () => {
    before(() => {
      upstream1.resetHandler()
      cleanups.push(withRoute(server, {
        id: nextRouteId('hc-ok'),
        matcher: { rule: "PathPrefix('/hc/ok')", priority: 50 },
        middlewares: [{ type: 'health_check', config: { retries: 1 } }],
        upstreams: tcpUpstream(upstream1.port),
      }))
    })

    it('request succeeds when upstream is healthy', async () => {
      const res = await proxyFetch(proxyPort, '/hc/ok/test')
      await res.text()
      assert.strictEqual(res.status, 200)
    })
  })

  describe('retries=1 + include_http_errors=true: fails over to second upstream', () => {
    before(() => {
      upstream1.setHandler((_req, res) => {
        res.setHeader('x-from', 'upstream1')
        res.statusCode = 500
        res.end('internal error')
      })
      upstream2.setHandler((_req, res) => {
        res.setHeader('x-from', 'upstream2')
        res.statusCode = 200
        res.end('ok from upstream2')
      })
      cleanups.push(withRoute(server, {
        id: nextRouteId('hc-retry'),
        matcher: { rule: "PathPrefix('/hc/retry')", priority: 50 },
        middlewares: [
          { type: 'health_check', config: { retries: 1, include_http_errors: true, failure_window_ms: 5000 } },
        ],
        upstreams: bothUpstreams(),
        loadBalancer: { algorithm: 'round_robin' },
      }))
    })
    after(() => { upstream1.resetHandler(); upstream2.resetHandler() })

    it('eventually gets a 200 from upstream2 after upstream1 5xx', async () => {
      let got200 = false
      for (let i = 0; i < 10; i++) {
        const res = await proxyFetch(proxyPort, '/hc/retry/test')
        const text = await res.text()
        if (res.status === 200 && res.headers.get('x-from') === 'upstream2') {
          got200 = true
          break
        }
      }
      assert.ok(got200, 'expected at least one 200 response from upstream2 after failover')
    })
  })

  describe('include_http_errors=false: 5xx does not trigger retry', () => {
    before(() => {
      upstream1.setHandler((_req, res) => {
        res.setHeader('x-from', 'upstream1')
        res.statusCode = 503
        res.end('service unavailable')
      })
      cleanups.push(withRoute(server, {
        id: nextRouteId('hc-nohttp'),
        matcher: { rule: "PathPrefix('/hc/nohttp')", priority: 50 },
        middlewares: [{ type: 'health_check', config: { retries: 1, include_http_errors: false } }],
        upstreams: tcpUpstream(upstream1.port),
      }))
    })
    after(() => upstream1.resetHandler())

    it('503 from upstream passes through when include_http_errors=false', async () => {
      const res = await proxyFetch(proxyPort, '/hc/nohttp/test')
      await res.text()
      assert.strictEqual(res.status, 503)
    })
  })
})
