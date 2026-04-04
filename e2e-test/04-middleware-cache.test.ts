import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startProxy } from './helpers/proxy.js'
import { createDynamicUpstream } from './helpers/upstream.js'
import { nextRouteId, tcpUpstream, withRoute } from './helpers/routes.js'
import { proxyFetch, assertHeader, assertNoHeader } from './helpers/request.js'
import { purgeRouteCache } from '../dist/index.js'
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
      assert.strictEqual(status1, 'bypass')
      assert.strictEqual(status2, 'bypass')
      assert.strictEqual(callCount, 2, `expected upstream called twice, got ${callCount}`)
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
      const status1 = res1.headers.get('cdn-cache-status')
      await res1.text()
      const res2 = await proxyFetch(proxyPort, '/cache/vary/item')
      const status2 = res2.headers.get('cdn-cache-status')
      await res2.text()
      assert.strictEqual(status1, 'bypass')
      assert.strictEqual(status2, 'bypass')
      assert.strictEqual(callCount, 2, `expected upstream called twice, got ${callCount}`)
    })
  })

  describe('rule-based cache enablement', () => {
    let callCount = 0

    before(() => {
      callCount = 0
      upstream.setHandler((_req, res) => {
        callCount++
        res.setHeader('cache-control', 'public, max-age=60')
        res.setHeader('content-type', 'text/plain')
        res.end(`body-${callCount}`)
      })

      cleanups.push(withRoute(server, {
        id: nextRouteId('cache-rule'),
        matcher: { rule: "PathPrefix('/cache/rule')", priority: 50 },
        middlewares: [
          {
            type: 'cache',
            config: {
              max_ttl_secs: 60,
              inject_cache_headers: true,
              rule: "Query('cache', '1')",
            },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })
    after(() => upstream.resetHandler())

    it('enables cache only when rule matches', async () => {
      const miss = await proxyFetch(proxyPort, '/cache/rule/item?cache=1')
      const missText = await miss.text()
      assert.strictEqual(miss.headers.get('cdn-cache-status'), 'miss')

      const hit = await proxyFetch(proxyPort, '/cache/rule/item?cache=1')
      const hitText = await hit.text()
      assert.strictEqual(hit.headers.get('cdn-cache-status'), 'hit')
      assert.strictEqual(hitText, missText)

      const bypass1 = await proxyFetch(proxyPort, '/cache/rule/item')
      await bypass1.text()
      const bypass2 = await proxyFetch(proxyPort, '/cache/rule/item')
      await bypass2.text()
      assert.strictEqual(bypass1.headers.get('cdn-cache-status'), null)
      assert.strictEqual(bypass2.headers.get('cdn-cache-status'), null)

      assert.strictEqual(callCount >= 3, true, `expected upstream called at least 3 times, got ${callCount}`)
    })
  })
})
