import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startProxy } from './helpers/proxy.js'
import { createDynamicUpstream } from './helpers/upstream.js'
import { nextRouteId, tcpUpstream, withRoute } from './helpers/routes.js'
import { getJson, proxyFetch, assertHeader, assertNoHeader } from './helpers/request.js'
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

// ─── RequestHeaders ──────────────────────────────────────────────────────────

describe('middleware: request_headers', () => {
  describe('set', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('rqh-set'),
        matcher: { rule: "PathPrefix('/rqh/set')", priority: 50 },
        middlewares: [
          {
            type: 'request_headers',
            config: { name: 'x-injected', action: 'set', value: 'injected' },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('upstream receives the injected header', async () => {
      const { body } = await getJson(proxyPort, '/rqh/set/test')
      assert.strictEqual(body.headers['x-injected'], 'injected')
    })
    it('set overwrites an existing header', async () => {
      const { body } = await getJson(proxyPort, '/rqh/set/test', { headers: { 'x-injected': 'original' } })
      assert.strictEqual(body.headers['x-injected'], 'injected')
    })
  })

  describe('append', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('rqh-append'),
        matcher: { rule: "PathPrefix('/rqh/append')", priority: 50 },
        middlewares: [
          {
            type: 'request_headers',
            config: { name: 'x-multi', action: 'append', value: 'appended' },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('appended value appears in upstream headers', async () => {
      const { body } = await getJson(proxyPort, '/rqh/append/test', { headers: { 'x-multi': 'first' } })
      assert.match(String(body.headers['x-multi'] ?? ''), /^first,\s*appended$/)
    })
  })

  describe('set_default', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('rqh-default'),
        matcher: { rule: "PathPrefix('/rqh/default')", priority: 50 },
        middlewares: [
          {
            type: 'request_headers',
            config: { name: 'x-default', action: 'set_default', value: 'fallback' },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('sets default when header is absent', async () => {
      const { body } = await getJson(proxyPort, '/rqh/default/test')
      assert.strictEqual(body.headers['x-default'], 'fallback')
    })
    it('keeps original when header is present', async () => {
      const { body } = await getJson(proxyPort, '/rqh/default/test', { headers: { 'x-default': 'original' } })
      assert.strictEqual(body.headers['x-default'], 'original')
    })
  })

  describe('remove', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('rqh-remove'),
        matcher: { rule: "PathPrefix('/rqh/remove')", priority: 50 },
        middlewares: [
          { type: 'request_headers', config: { name: 'x-secret', action: 'remove' } },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('upstream does not receive the removed header', async () => {
      const { body } = await getJson(proxyPort, '/rqh/remove/test', { headers: { 'x-secret': 'should-be-gone' } })
      assert.strictEqual(body.headers['x-secret'], undefined)
    })
  })

  describe('rule condition', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('rqh-rule'),
        matcher: { rule: "PathPrefix('/rqh/rule')", priority: 50 },
        middlewares: [
          {
            type: 'request_headers',
            config: {
              name: 'x-conditional',
              action: 'set',
              value: 'yes',
              rule: "Query('apply', '1')",
            },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('applies header when rule matches', async () => {
      const { body } = await getJson(proxyPort, '/rqh/rule/test?apply=1')
      assert.strictEqual(body.headers['x-conditional'], 'yes')
    })
    it('does not apply header when rule does not match', async () => {
      const { body } = await getJson(proxyPort, '/rqh/rule/test')
      assert.strictEqual(body.headers['x-conditional'], undefined)
    })
  })

  describe('expression', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('rqh-expr'),
        matcher: { rule: "PathPrefix('/rqh/expression')", priority: 50 },
        middlewares: [
          {
            type: 'request_headers',
            config: {
              name: 'x-rqh-expr',
              action: 'set',
              expression: "MethodValue() + '-' + QueryValue('id')",
            },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('sets request header from CEL expression', async () => {
      const { body } = await getJson(proxyPort, '/rqh/expression/test?id=42', { method: 'POST' })
      assert.strictEqual(body.headers['x-rqh-expr'], 'POST-42')
    })
  })
})

// ─── ResponseHeaders ─────────────────────────────────────────────────────────

describe('middleware: response_headers', () => {
  describe('set', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('rsh-set'),
        matcher: { rule: "PathPrefix('/rsh/set')", priority: 50 },
        middlewares: [
          {
            type: 'response_headers',
            config: { name: 'x-resp', action: 'set', value: 'hello' },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('response contains injected header', async () => {
      const res = await proxyFetch(proxyPort, '/rsh/set/test')
      await res.text()
      assertHeader(res, 'x-resp', 'hello')
    })
  })

  describe('remove', () => {
    before(() => {
      upstream.setHandler((_req, res) => {
        res.setHeader('x-remove-me', 'present')
        res.statusCode = 200
        res.end('ok')
      })
      cleanups.push(withRoute(server, {
        id: nextRouteId('rsh-remove'),
        matcher: { rule: "PathPrefix('/rsh/remove')", priority: 50 },
        middlewares: [
          { type: 'response_headers', config: { name: 'x-remove-me', action: 'remove' } },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })
    after(() => upstream.resetHandler())

    it('response does not contain the removed header', async () => {
      const res = await proxyFetch(proxyPort, '/rsh/remove/test')
      await res.text()
      assertNoHeader(res, 'x-remove-me')
    })
  })

  describe('set_default', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('rsh-default'),
        matcher: { rule: "PathPrefix('/rsh/default')", priority: 50 },
        middlewares: [
          {
            type: 'response_headers',
            config: {
              name: 'x-rdefault',
              action: 'set_default',
              value: 'fallback',
            },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('sets default header when upstream does not send it', async () => {
      upstream.setHandler((_req, res) => {
        res.statusCode = 200
        res.end('ok')
      })
      const res = await proxyFetch(proxyPort, '/rsh/default/test')
      await res.text()
      assertHeader(res, 'x-rdefault', 'fallback')
      upstream.resetHandler()
    })
    it('keeps upstream header when already set', async () => {
      upstream.setHandler((_req, res) => {
        res.setHeader('x-rdefault', 'upstream-value')
        res.statusCode = 200
        res.end('ok')
      })
      const res = await proxyFetch(proxyPort, '/rsh/default/test')
      await res.text()
      assertHeader(res, 'x-rdefault', 'upstream-value')
      upstream.resetHandler()
    })
  })

  describe('append', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('rsh-append'),
        matcher: { rule: "PathPrefix('/rsh/append')", priority: 50 },
        middlewares: [
          {
            type: 'response_headers',
            config: { name: 'x-tags', action: 'append', value: 'proxy' },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('appended value is present in response header', async () => {
      upstream.setHandler((_req, res) => {
        res.setHeader('x-tags', 'origin')
        res.statusCode = 200
        res.end('ok')
      })
      const res = await proxyFetch(proxyPort, '/rsh/append/test')
      await res.text()
      assert.match(res.headers.get('x-tags') ?? '', /^origin,\s*proxy$/)
      upstream.resetHandler()
    })
  })

  describe('expression', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('rsh-expr'),
        matcher: { rule: "PathPrefix('/rsh/expression')", priority: 50 },
        middlewares: [
          {
            type: 'response_headers',
            config: {
              name: 'x-rsh-expr',
              action: 'set',
              expression: "PathValue() + '-' + HeaderValue('x-user')",
            },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('sets response header from CEL expression', async () => {
      const res = await proxyFetch(proxyPort, '/rsh/expression/test', { headers: { 'x-user': 'u9' } })
      await res.text()
      assertHeader(res, 'x-rsh-expr', '/rsh/expression/test-u9')
    })
  })
})
