import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startProxy } from './helpers/proxy.js'
import { createDynamicUpstream } from './helpers/upstream.js'
import { nextRouteId, tcpUpstream, withRoute } from './helpers/routes.js'
import { proxyFetch, assertHeader, requestWithCustomHost } from './helpers/request.js'
import type { LonesomeServer } from '../dist/index.js'

let server: LonesomeServer
let proxyPort: number
const upstream = createDynamicUpstream()
const cleanups: Array<() => void> = []

before(async () => {
  await upstream.start()
  ;({ server, port: proxyPort } = await startProxy())
})

after(async () => {
  cleanups.forEach((fn) => fn())
  server.stop()
  await upstream.stop()
})

describe('middleware: cors', () => {
  describe('exact origin_mode', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('cors-exact'),
        matcher: { rule: "PathPrefix('/cors/exact')", priority: 50 },
        middlewares: [
          {
            type: 'cors',
            config: {
              origin_mode: 'exact',
              allow_origin: 'https://app.example.com',
              allow_methods: 'GET,POST',
              allow_headers: 'content-type,x-custom',
              max_age_secs: 600,
            },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('OPTIONS preflight returns 204', async () => {
      const res = await proxyFetch(proxyPort, '/cors/exact/api', {
        method: 'OPTIONS',
        headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST' },
      })
      await res.text()
      assert.strictEqual(res.status, 204)
    })
    it('preflight response contains allow-origin', async () => {
      const res = await proxyFetch(proxyPort, '/cors/exact/api', {
        method: 'OPTIONS',
        headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST' },
      })
      await res.text()
      assertHeader(res, 'access-control-allow-origin', 'https://app.example.com')
    })
    it('preflight response contains allow-methods', async () => {
      const res = await proxyFetch(proxyPort, '/cors/exact/api', {
        method: 'OPTIONS',
        headers: { origin: 'https://app.example.com', 'access-control-request-method': 'GET' },
      })
      await res.text()
      assertHeader(res, 'access-control-allow-methods', 'GET,POST')
    })
    it('preflight response contains max-age', async () => {
      const res = await proxyFetch(proxyPort, '/cors/exact/api', {
        method: 'OPTIONS',
        headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST' },
      })
      await res.text()
      assertHeader(res, 'access-control-max-age', '600')
    })
    it('GET request response contains allow-origin', async () => {
      const res = await proxyFetch(proxyPort, '/cors/exact/api', {
        headers: { origin: 'https://app.example.com' },
      })
      await res.text()
      assertHeader(res, 'access-control-allow-origin', 'https://app.example.com')
    })
  })

  describe('reflect_host origin_mode', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('cors-reflect'),
        matcher: { rule: "PathPrefix('/cors/reflect')", priority: 50 },
        middlewares: [
          { type: 'cors', config: { reflect_host: true, allow_methods: 'GET' } },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('sets allow-origin based on host header', async () => {
      const { response } = await requestWithCustomHost(proxyPort, '/cors/reflect/api', 'myapp.local', {
        headers: { origin: 'https://myapp.local' },
      })
      const origin = String(response.headers['access-control-allow-origin'] ?? '')
      assert.strictEqual(origin, 'https://myapp.local')
    })
    it('adds Vary: host', async () => {
      const { response } = await requestWithCustomHost(proxyPort, '/cors/reflect/api', 'myapp.local', {
        headers: { origin: 'https://myapp.local' },
      })
      const vary = String(response.headers['vary'] ?? '')
      assert.match(vary, /(^|,\s*)host(\s*,|$)/i, `expected 'host' token in Vary, got ${vary}`)
    })
  })

  describe('allow_credentials', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('cors-creds'),
        matcher: { rule: "PathPrefix('/cors/creds')", priority: 50 },
        middlewares: [
          {
            type: 'cors',
            config: { origin_mode: 'exact', allow_origin: 'https://secure.example.com', allow_credentials: true },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('response contains access-control-allow-credentials: true', async () => {
      const res = await proxyFetch(proxyPort, '/cors/creds/api', {
        headers: { origin: 'https://secure.example.com' },
      })
      await res.text()
      assertHeader(res, 'access-control-allow-credentials', 'true')
    })
  })

  describe('expose_headers', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('cors-expose'),
        matcher: { rule: "PathPrefix('/cors/expose')", priority: 50 },
        middlewares: [
          {
            type: 'cors',
            config: { origin_mode: 'exact', allow_origin: '*', expose_headers: 'x-request-id,x-trace' },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('response contains access-control-expose-headers', async () => {
      const res = await proxyFetch(proxyPort, '/cors/expose/api', {
        headers: { origin: 'https://client.example.com' },
      })
      await res.text()
      assertHeader(res, 'access-control-expose-headers', 'x-request-id,x-trace')
    })
  })
})
