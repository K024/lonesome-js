import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startProxy } from './helpers/proxy.js'
import { createDynamicUpstream } from './helpers/upstream.js'
import { nextRouteId, tcpUpstream, withRoute } from './helpers/routes.js'
import { proxyFetch } from './helpers/request.js'
import type { DenaliServer } from '../dist/index.js'

let server: DenaliServer
let proxyPort: number
const upstream = createDynamicUpstream()
const cleanups: Array<() => void> = []

const OBSERVE_SECONDS = 10
const MAX_RPS = 1
const WINDOW_ALLOWANCE = Math.round(OBSERVE_SECONDS * MAX_RPS)

before(async () => {
  await upstream.start()
  ;({ server, port: proxyPort } = await startProxy())
})

after(async () => {
  cleanups.forEach((fn) => fn())
  server.stop()
  await upstream.stop()
})

async function burstStatuses(path: string, n: number, opts?: RequestInit): Promise<number[]> {
  const results = await Promise.all(
    Array.from({ length: n }, () =>
      proxyFetch(proxyPort, path, opts).then(async (r) => {
        await r.text()
        return r.status
      }),
    ),
  )
  return results
}

describe('middleware: rate_limit', () => {
  describe('remote_ip mode', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('rl-ip'),
        matcher: { rule: "PathPrefix('/rl/ip')", priority: 50 },
        middlewares: [{ type: 'rate_limit', config: { mode: 'remote_ip', max_rps: MAX_RPS, include_headers: true } }],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('allows windowed requests through', async () => {
      const statuses = await burstStatuses('/rl/ip/test', WINDOW_ALLOWANCE)
      assert.strictEqual(statuses.every(s => s === 200), true)
    })

    it('returns 429 when requests exceed observe-window quota', async () => {
      const statuses = await burstStatuses('/rl/ip/test', WINDOW_ALLOWANCE + 12)
      assert.ok(statuses.includes(429), `expected at least one 429, got: ${statuses.join(',')}`)
    })

    it('429 response includes rate-limit headers', async () => {
      let found429: Response | null = null
      for (let i = 0; i < WINDOW_ALLOWANCE + 20 && !found429; i++) {
        const res = await proxyFetch(proxyPort, '/rl/ip/test')
        if (res.status === 429) {
          found429 = res
        } else {
          await res.text()
        }
      }
      assert.ok(found429, 'expected a 429 response')
      assert.ok(found429!.headers.get('x-ratelimit-limit') !== null, 'x-ratelimit-limit should be present')
      assert.ok(found429!.headers.get('x-ratelimit-remaining') !== null, 'x-ratelimit-remaining should be present')
      assert.ok(found429!.headers.get('x-ratelimit-reset') !== null, 'x-ratelimit-reset should be present')
      await found429!.text()
    })
  })

  describe('header mode', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('rl-hdr'),
        matcher: { rule: "PathPrefix('/rl/hdr')", priority: 50 },
        middlewares: [{ type: 'rate_limit', config: { mode: 'header', header_name: 'x-user-id', max_rps: MAX_RPS } }],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('different header keys have independent counters', async () => {
      const statusesA = await burstStatuses('/rl/hdr/test', WINDOW_ALLOWANCE + 12, { headers: { 'x-user-id': 'user-a' } })
      const resB = await proxyFetch(proxyPort, '/rl/hdr/test', { headers: { 'x-user-id': 'user-b' } })
      await resB.text()
      assert.ok(statusesA.includes(429), 'user-a should be rate limited')
      assert.strictEqual(resB.status, 200)
    })
  })

  describe('expression mode', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('rl-expr'),
        matcher: { rule: "PathPrefix('/rl/expr')", priority: 50 },
        middlewares: [
          { type: 'rate_limit', config: { mode: 'expression', key: "HeaderValue('x-tenant')", max_rps: MAX_RPS } },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('CEL expression key is evaluated for rate limiting', async () => {
      const statuses = await burstStatuses('/rl/expr/test', WINDOW_ALLOWANCE + 12, { headers: { 'x-tenant': 'tenant-1' } })
      assert.ok(statuses.includes(429), 'expected rate limiting by CEL key')
    })
  })

  describe('bypass when key absent', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('rl-bypass'),
        matcher: { rule: "PathPrefix('/rl/bypass')", priority: 50 },
        middlewares: [{ type: 'rate_limit', config: { mode: 'header', header_name: 'x-rate-key', max_rps: MAX_RPS } }],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('bypasses rate limiting when header key is absent', async () => {
      const statuses = await burstStatuses('/rl/bypass/test', WINDOW_ALLOWANCE + 12)
      assert.ok(!statuses.includes(429), `expected no 429 without key, got: ${statuses.join(',')}`)
    })
  })
})
