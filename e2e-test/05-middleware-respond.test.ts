import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startProxy } from './helpers/proxy.js'
import { createDynamicUpstream } from './helpers/upstream.js'
import { nextRouteId, tcpUpstream, withRoute } from './helpers/routes.js'
import { assertStatus, proxyFetch, assertHeader, getJson } from './helpers/request.js'
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

describe('middleware: respond', () => {
  describe('no body', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('respond-nobody'),
        matcher: { rule: "PathPrefix('/respond/nobody')", priority: 50 },
        middlewares: [{ type: 'respond', config: { status: 204 } }],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('returns configured status code', async () => {
      await assertStatus(proxyPort, '/respond/nobody', 204)
    })
    it('returns content-length: 0', async () => {
      const res = await proxyFetch(proxyPort, '/respond/nobody')
      await res.text()
      assertHeader(res, 'content-length', '0')
    })
    it('body is empty', async () => {
      const res = await proxyFetch(proxyPort, '/respond/nobody')
      const text = await res.text()
      assert.strictEqual(text, '')
    })
  })

  describe('with body', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('respond-body'),
        matcher: { rule: "PathPrefix('/respond/body')", priority: 50 },
        middlewares: [
          { type: 'respond', config: { status: 200, body: 'hello respond', content_type: 'text/plain; charset=utf-8' } },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('returns correct body', async () => {
      const res = await proxyFetch(proxyPort, '/respond/body')
      const text = await res.text()
      assert.strictEqual(text, 'hello respond')
    })
    it('returns correct content-type', async () => {
      const res = await proxyFetch(proxyPort, '/respond/body')
      await res.text()
      assertHeader(res, 'content-type', 'text/plain; charset=utf-8')
    })
  })

  describe('custom status codes', () => {
    for (const status of [400, 403, 418, 500]) {
      it(`returns status ${status}`, async () => {
        const id = nextRouteId(`respond-${status}`)
        const clean = withRoute(server, {
          id,
          matcher: { rule: `PathPrefix('/respond/status/${status}')`, priority: 50 },
          middlewares: [{ type: 'respond', config: { status } }],
          upstreams: tcpUpstream(upstream.port),
        })
        await assertStatus(proxyPort, `/respond/status/${status}`, status)
        clean()
      })
    }
  })

  describe('with CEL rule condition', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('respond-rule'),
        matcher: { rule: "PathPrefix('/respond/rule')", priority: 50 },
        middlewares: [
          { type: 'respond', config: { status: 403, body: 'forbidden', rule: "Method('GET')" } },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('short-circuits when rule matches (GET)', async () => {
      await assertStatus(proxyPort, '/respond/rule', 403)
    })
    it('passes through to upstream when rule does not match (POST)', async () => {
      const { res } = await getJson(proxyPort, '/respond/rule', { method: 'POST' })
      assert.strictEqual(res.status, 200)
    })
  })
})
