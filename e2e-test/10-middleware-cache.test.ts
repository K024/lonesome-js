import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startProxy } from './helpers/proxy.js'
import { createDynamicUpstream } from './helpers/upstream.js'
import { nextRouteId, tcpUpstream, withRoute } from './helpers/routes.js'
import { proxyFetch, assertHeader, assertNoHeader } from './helpers/request.js'
import { purgeRouteCache } from '../dist/index.js'
import type { DenaliServer } from '../dist/index.js'

let server: DenaliServer
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

describe('middleware: cache', () => {
  describe('MISS then HIT', () => {
    let callCount = 0

    before(() => {
      callCount = 0
      upstream.setHandler((_req, res) => {
        callCount++
        res.setHeader('cache-control', 'public, max-age=60')
        res.setHeader('content-type', 'text/plain')
        res.end('cached-body')
      })
      cleanups.push(withRoute(server, {
        id: nextRouteId('cache-hit'),
        matcher: { rule: "PathPrefix('/cache/hit')", priority: 50 },
        middlewares: [{ type: 'cache', config: { max_ttl_secs: 60, inject_cache_headers: true } }],
        upstreams: tcpUpstream(upstream.port),
      }))
    })
    after(() => upstream.resetHandler())

    it('first request returns MISS', async () => {
      const res = await proxyFetch(proxyPort, '/cache/hit/item1')
      await res.text()
      assertHeader(res, 'cdn-cache-status', 'miss')
    })
    it('second request returns HIT', async () => {
      const res = await proxyFetch(proxyPort, '/cache/hit/item1')
      await res.text()
      assertHeader(res, 'cdn-cache-status', 'hit')
    })
    it('upstream is called only once for both requests', () => {
      assert.strictEqual(callCount, 1, `upstream should be called once, got ${callCount}`)
    })
  })

  describe('purgeRouteCache', () => {
    let routeId: string
    let callCount = 0

    before(() => {
      callCount = 0
      upstream.setHandler((_req, res) => {
        callCount++
        res.setHeader('cache-control', 'public, max-age=300')
        res.setHeader('content-type', 'text/plain')
        res.end(`response-${callCount}`)
      })
      routeId = nextRouteId('cache-purge')
      cleanups.push(withRoute(server, {
        id: routeId,
        matcher: { rule: "PathPrefix('/cache/purge')", priority: 50 },
        middlewares: [{ type: 'cache', config: { max_ttl_secs: 300, inject_cache_headers: true } }],
        upstreams: tcpUpstream(upstream.port),
      }))
    })
    after(() => upstream.resetHandler())

    it('primes cache (first MISS)', async () => {
      const res = await proxyFetch(proxyPort, '/cache/purge/item')
      await res.text()
      assertHeader(res, 'cdn-cache-status', 'miss')
    })
    it('second request is HIT', async () => {
      const res = await proxyFetch(proxyPort, '/cache/purge/item')
      await res.text()
      assertHeader(res, 'cdn-cache-status', 'hit')
    })
    it('after purge, next request is MISS again', async () => {
      await purgeRouteCache(routeId)
      const res = await proxyFetch(proxyPort, '/cache/purge/item')
      await res.text()
      assertHeader(res, 'cdn-cache-status', 'miss')
    })
  })

  describe('inject_cache_headers=false', () => {
    before(() => {
      upstream.setHandler((_req, res) => {
        res.setHeader('cache-control', 'public, max-age=60')
        res.end('ok')
      })
      cleanups.push(withRoute(server, {
        id: nextRouteId('cache-nohdr'),
        matcher: { rule: "PathPrefix('/cache/nohdr')", priority: 50 },
        middlewares: [{ type: 'cache', config: { max_ttl_secs: 60, inject_cache_headers: false } }],
        upstreams: tcpUpstream(upstream.port),
      }))
    })
    after(() => upstream.resetHandler())

    it('response does not contain cdn-cache-status', async () => {
      const res = await proxyFetch(proxyPort, '/cache/nohdr/item')
      await res.text()
      assertNoHeader(res, 'cdn-cache-status')
    })
  })

  describe('cache-control: no-store', () => {
    let callCount = 0

    before(() => {
      callCount = 0
      upstream.setHandler((_req, res) => {
        callCount++
        res.setHeader('cache-control', 'no-store')
        res.end('not-cached')
      })
      cleanups.push(withRoute(server, {
        id: nextRouteId('cache-nostore'),
        matcher: { rule: "PathPrefix('/cache/nostore')", priority: 50 },
        middlewares: [{ type: 'cache', config: { max_ttl_secs: 60, inject_cache_headers: true } }],
        upstreams: tcpUpstream(upstream.port),
      }))
    })
    after(() => upstream.resetHandler())

    it('no-store response is never cached (always MISS)', async () => {
      const res1 = await proxyFetch(proxyPort, '/cache/nostore/item')
      const status1 = res1.headers.get('cdn-cache-status')
      await res1.text()
      const res2 = await proxyFetch(proxyPort, '/cache/nostore/item')
      const status2 = res2.headers.get('cdn-cache-status')
      await res2.text()
      assert.notStrictEqual(status1, 'hit')
      assert.notStrictEqual(status2, 'hit')
      assert.ok(callCount >= 2, `upstream should be called at least twice, got ${callCount}`)
    })
  })

  describe('Vary: * bypasses cache', () => {
    let callCount = 0

    before(() => {
      callCount = 0
      upstream.setHandler((_req, res) => {
        callCount++
        res.setHeader('cache-control', 'public, max-age=60')
        res.setHeader('vary', '*')
        res.end('vary-star')
      })
      cleanups.push(withRoute(server, {
        id: nextRouteId('cache-vary'),
        matcher: { rule: "PathPrefix('/cache/vary')", priority: 50 },
        middlewares: [{ type: 'cache', config: { max_ttl_secs: 60, inject_cache_headers: true } }],
        upstreams: tcpUpstream(upstream.port),
      }))
    })
    after(() => upstream.resetHandler())

    it('Vary: * response is not cached', async () => {
      const res1 = await proxyFetch(proxyPort, '/cache/vary/item')
      await res1.text()
      const res2 = await proxyFetch(proxyPort, '/cache/vary/item')
      await res2.text()
      assert.notStrictEqual(res1.headers.get('cdn-cache-status'), 'hit')
      assert.notStrictEqual(res2.headers.get('cdn-cache-status'), 'hit')
      assert.ok(callCount >= 2, `expected upstream called at least twice, got ${callCount}`)
    })
  })
})
