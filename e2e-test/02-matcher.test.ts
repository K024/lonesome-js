import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startProxy } from './helpers/proxy.js'
import { createDynamicUpstream } from './helpers/upstream.js'
import { nextRouteId, tcpUpstream, withRoute } from './helpers/routes.js'
import { assertStatus, proxyFetch, requestWithCustomHost } from './helpers/request.js'
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

function route(rule: string, priority = 50) {
  const id = nextRouteId('matcher')
  cleanups.push(withRoute(server, { id, matcher: { rule, priority }, middlewares: [], upstreams: tcpUpstream(upstream.port) }))
  return id
}

describe('matcher', () => {
  describe('PathPrefix', () => {
    before(() => route("PathPrefix('/m/prefix')"))

    it('matches request under prefix', async () => {
      await assertStatus(proxyPort, '/m/prefix/anything', 200)
    })
    it('does not match outside prefix', async () => {
      await assertStatus(proxyPort, '/other/path', 404)
    })
  })

  describe('Path (exact)', () => {
    before(() => route("Path('/m/exact')"))

    it('matches exact path', async () => {
      await assertStatus(proxyPort, '/m/exact', 200)
    })
    it('does not match path with suffix', async () => {
      await assertStatus(proxyPort, '/m/exact/more', 404)
    })
  })

  describe('PathRegexp', () => {
    before(() => route("PathRegexp('^/m/re/[0-9]+$')"))

    it('matches numeric segment', async () => {
      await assertStatus(proxyPort, '/m/re/123', 200)
    })
    it('does not match non-numeric segment', async () => {
      await assertStatus(proxyPort, '/m/re/abc', 404)
    })
  })

  describe('Method', () => {
    before(() => route("Method('POST') && PathPrefix('/m/method')"))

    it('matches POST', async () => {
      await assertStatus(proxyPort, '/m/method/test', 200, { method: 'POST' })
    })
    it('does not match GET', async () => {
      await assertStatus(proxyPort, '/m/method/test', 404, { method: 'GET' })
    })
  })

  describe('Host', () => {
    before(() => route("Host('testhost') && PathPrefix('/m/host')"))

    it('matches correct Host header', async () => {
      const { response } = await requestWithCustomHost(proxyPort, '/m/host/test', 'testhost')
      assert.strictEqual(response.statusCode, 200)
    })
    it('does not match wrong Host header', async () => {
      const { response } = await requestWithCustomHost(proxyPort, '/m/host/test', 'wronghost')
      assert.strictEqual(response.statusCode, 404)
    })
  })

  describe('Header (exact)', () => {
    before(() => route("Header('x-env', 'prod') && PathPrefix('/m/hdr')"))

    it('matches exact header value', async () => {
      const res = await proxyFetch(proxyPort, '/m/hdr/test', { headers: { 'x-env': 'prod' } })
      await res.text()
      assert.strictEqual(res.status, 200)
    })
    it('does not match wrong header value', async () => {
      const res = await proxyFetch(proxyPort, '/m/hdr/test', { headers: { 'x-env': 'staging' } })
      await res.text()
      assert.strictEqual(res.status, 404)
    })
  })

  describe('HeaderRegexp', () => {
    before(() => route("HeaderRegexp('x-ver', '^v[0-9]+') && PathPrefix('/m/hdre')"))

    it('matches header matching regexp', async () => {
      const res = await proxyFetch(proxyPort, '/m/hdre/test', { headers: { 'x-ver': 'v42' } })
      await res.text()
      assert.strictEqual(res.status, 200)
    })
    it('does not match header not matching regexp', async () => {
      const res = await proxyFetch(proxyPort, '/m/hdre/test', { headers: { 'x-ver': 'r42' } })
      await res.text()
      assert.strictEqual(res.status, 404)
    })
  })

  describe('Query (exact)', () => {
    before(() => route("Query('debug', '1') && PathPrefix('/m/query')"))

    it('matches exact query param', async () => {
      await assertStatus(proxyPort, '/m/query/test?debug=1', 200)
    })
    it('does not match wrong query value', async () => {
      await assertStatus(proxyPort, '/m/query/test?debug=0', 404)
    })
    it('does not match missing query param', async () => {
      await assertStatus(proxyPort, '/m/query/test', 404)
    })
  })

  describe('QueryRegexp', () => {
    before(() => route("QueryRegexp('id', '^[0-9]+$') && PathPrefix('/m/qre')"))

    it('matches numeric id', async () => {
      await assertStatus(proxyPort, '/m/qre/test?id=999', 200)
    })
    it('does not match non-numeric id', async () => {
      await assertStatus(proxyPort, '/m/qre/test?id=abc', 404)
    })
  })

  describe('priority', () => {
    it('high-priority route wins over overlapping lower-priority route', async () => {
      const lowId = nextRouteId('prio-low')
      const highId = nextRouteId('prio-high')

      const cleanLow = withRoute(server, {
        id: lowId,
        matcher: { rule: "PathPrefix('/m/prio')", priority: 1 },
        middlewares: [],
        upstreams: tcpUpstream(upstream.port),
      })
      const cleanHigh = withRoute(server, {
        id: highId,
        matcher: { rule: "PathPrefix('/m/prio')", priority: 100 },
        middlewares: [{ type: 'respond', config: { status: 418 } }],
        upstreams: tcpUpstream(upstream.port),
      })

      const res = await proxyFetch(proxyPort, '/m/prio/test')
      await res.text()
      assert.strictEqual(res.status, 418)

      cleanHigh()
      cleanLow()
    })
  })
})
