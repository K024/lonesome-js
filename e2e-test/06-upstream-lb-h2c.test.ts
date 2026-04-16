import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startProxy } from './helpers/proxy.js'
import { createDynamicUpstream, createH2cUpstream } from './helpers/upstream.js'
import { nextRouteId, withRoute } from './helpers/routes.js'
import { getJson, proxyFetch } from './helpers/request.js'
import type { LonesomeServer } from '../dist/index.js'

let server: LonesomeServer
let proxyPort: number
const upstreamA = createDynamicUpstream()
const upstreamB = createDynamicUpstream()
const h2cUpstream = createH2cUpstream()
const cleanups: Array<() => void> = []

before(async () => {
  await upstreamA.start()
  await upstreamB.start()
  await h2cUpstream.start()
  ;({ server, port: proxyPort } = await startProxy())
})

after(async () => {
  cleanups.forEach((fn) => fn())
  server.stop()
  await upstreamA.stop()
  await upstreamB.stop()
  await h2cUpstream.stop()
})

describe('upstream selection and protocols', () => {
  describe('h2c upstream', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('h2c'),
        matcher: { rule: "PathPrefix('/h2c')", priority: 60 },
        middlewares: [],
        upstreams: [{
          kind: 'tcp',
          address: `127.0.0.1:${h2cUpstream.port}`,
          tls: false,
          h2c: true,
          sni: '',
          weight: 1,
        }],
      }))
    })

    it('proxies HTTP/1 client requests to h2c upstream', async () => {
      const { res, body } = await getJson(proxyPort, '/h2c/demo?x=1')
      assert.strictEqual(res.status, 200)
      assert.strictEqual(body.protocol, 'h2c')
      assert.strictEqual(body.method, 'GET')
      assert.strictEqual(body.url, '/h2c/demo?x=1')
    })
  })

  describe('consistent_hash with hash_key_rule', () => {
    before(() => {
      upstreamA.setHandler((_req, res) => {
        res.setHeader('x-from', 'a')
        res.end('a')
      })
      upstreamB.setHandler((_req, res) => {
        res.setHeader('x-from', 'b')
        res.end('b')
      })
      cleanups.push(withRoute(server, {
        id: nextRouteId('lb-chash'),
        matcher: { rule: "PathPrefix('/lb/hash')", priority: 60 },
        middlewares: [],
        upstreams: [
          { kind: 'tcp', address: `127.0.0.1:${upstreamA.port}`, tls: false, sni: '', weight: 1 },
          { kind: 'tcp', address: `127.0.0.1:${upstreamB.port}`, tls: false, sni: '', weight: 1 },
        ],
        loadBalancer: {
          algorithm: 'consistent_hash',
          maxIterations: 32,
          hashKeyRule: "HeaderValue('x-user')",
        },
      }))
    })

    after(() => {
      upstreamA.resetHandler()
      upstreamB.resetHandler()
    })

    it('same hash key is routed consistently to same upstream', async () => {
      const seen = new Set<string>()
      for (let i = 0; i < 8; i++) {
        const res = await proxyFetch(proxyPort, '/lb/hash/item', { headers: { 'x-user': 'alice' } })
        await res.text()
        seen.add(res.headers.get('x-from') ?? '')
      }
      assert.strictEqual(seen.size, 1, `expected single upstream for same hash key, got ${Array.from(seen).join(',')}`)
    })

    it('different hash keys can route to different upstreams', async () => {
      const keys = ['alice', 'bob', 'carol', 'dave', 'eric', 'frank', 'grace', 'hank']
      const seen = new Set<string>()
      for (const key of keys) {
        const res = await proxyFetch(proxyPort, '/lb/hash/item', { headers: { 'x-user': key } })
        await res.text()
        seen.add(res.headers.get('x-from') ?? '')
      }
      assert.strictEqual(seen.size >= 2, true, `expected at least two upstreams across keys, got ${Array.from(seen).join(',')}`)
    })
  })

  describe('round_robin balancing', () => {
    before(() => {
      upstreamA.setHandler((_req, res) => {
        res.setHeader('x-upstream', 'A')
        res.end('A')
      })
      upstreamB.setHandler((_req, res) => {
        res.setHeader('x-upstream', 'B')
        res.end('B')
      })

      cleanups.push(withRoute(server, {
        id: nextRouteId('lb-rr'),
        matcher: { rule: "PathPrefix('/lb/rr')", priority: 60 },
        middlewares: [],
        upstreams: [
          { kind: 'tcp', address: `127.0.0.1:${upstreamA.port}`, tls: false, sni: '', weight: 1 },
          { kind: 'tcp', address: `127.0.0.1:${upstreamB.port}`, tls: false, sni: '', weight: 1 },
        ],
        loadBalancer: { algorithm: 'round_robin', maxIterations: 16 },
      }))
    })

    after(() => {
      upstreamA.resetHandler()
      upstreamB.resetHandler()
    })

    it('distributes requests across both upstreams', async () => {
      const seen = new Set<string>()
      for (let i = 0; i < 8; i++) {
        const res = await proxyFetch(proxyPort, '/lb/rr/demo')
        await res.text()
        seen.add(res.headers.get('x-upstream') ?? '')
      }

      assert.strictEqual(seen.has('A'), true, `expected upstream A in set, got ${Array.from(seen).join(',')}`)
      assert.strictEqual(seen.has('B'), true, `expected upstream B in set, got ${Array.from(seen).join(',')}`)
    })
  })
})
