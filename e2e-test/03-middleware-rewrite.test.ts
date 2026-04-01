import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startProxy } from './helpers/proxy.js'
import { createDynamicUpstream } from './helpers/upstream.js'
import { nextRouteId, tcpUpstream, withRoute } from './helpers/routes.js'
import { getJson } from './helpers/request.js'
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

describe('middleware: rewrite', () => {
  describe('regex_rewrite', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('rw-regex'),
        matcher: { rule: "PathPrefix('/rw/api')", priority: 50 },
        middlewares: [
          { type: 'rewrite', config: { mode: 'regex_rewrite', find: '^/rw/api/(.*)$', replace: '/$1' } },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('strips /rw/api prefix via regex rewrite', async () => {
      const { body } = await getJson(proxyPort, '/rw/api/foo/bar')
      assert.strictEqual(body.url, '/foo/bar')
    })
    it('preserves query string after rewrite', async () => {
      const { body } = await getJson(proxyPort, '/rw/api/foo?x=1')
      assert.strictEqual(body.url, '/foo?x=1')
    })
  })

  describe('cel_rewrite', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('rw-cel'),
        matcher: { rule: "PathPrefix('/rw/cel')", priority: 50 },
        middlewares: [
          { type: 'rewrite', config: { mode: 'cel_rewrite', expression: "'/new' + PathValue()" } },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('rewrites path via CEL expression', async () => {
      const { body } = await getJson(proxyPort, '/rw/cel/hello')
      assert.strictEqual(body.url, '/new/rw/cel/hello')
    })
  })

  describe('rewrite_method', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('rw-method'),
        matcher: { rule: "PathPrefix('/rw/method')", priority: 50 },
        middlewares: [
          { type: 'rewrite_method', config: { method: 'POST', rule: "PathPrefix('/rw/method/post')" } },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('rewrites GET to POST when rule matches', async () => {
      const { body } = await getJson(proxyPort, '/rw/method/post/test')
      assert.strictEqual(body.method, 'POST')
    })
    it('keeps original method when rule does not match', async () => {
      const { body } = await getJson(proxyPort, '/rw/method/other')
      assert.strictEqual(body.method, 'GET')
    })
  })

  describe('rewrite + rewrite_method combined', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('rw-combo'),
        matcher: { rule: "PathPrefix('/rw/combo')", priority: 50 },
        middlewares: [
          { type: 'rewrite', config: { mode: 'regex_rewrite', find: '^/rw/combo/(.*)$', replace: '/$1' } },
          { type: 'rewrite_method', config: { method: 'PUT' } },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('applies both path rewrite and method rewrite', async () => {
      const { body } = await getJson(proxyPort, '/rw/combo/target')
      assert.strictEqual(body.url, '/target')
      assert.strictEqual(body.method, 'PUT')
    })
  })
})
