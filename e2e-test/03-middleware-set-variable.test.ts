import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startProxy } from './helpers/proxy.js'
import { createDynamicUpstream } from './helpers/upstream.js'
import { nextRouteId, tcpUpstream, withRoute } from './helpers/routes.js'
import { assertHeader, getJson, proxyFetch } from './helpers/request.js'
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

describe('middleware: set_variable', () => {
  describe('default stage', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('setvar-default-stage'),
        matcher: { rule: "PathPrefix('/setvar/default-stage')", priority: 50 },
        middlewares: [
          {
            type: 'set_variable',
            config: {
              name: 'default_tag',
              expression: "MethodValue() + '-' + QueryValue('id')",
            },
          },
          {
            type: 'request_headers',
            config: {
              name: 'x-default-stage',
              action: 'set',
              expression: 'default_tag',
            },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('uses request stage by default when stage is omitted', async () => {
      const { body } = await getJson(proxyPort, '/setvar/default-stage/test?id=7', { method: 'POST' })
      assert.strictEqual(body.headers['x-default-stage'], 'POST-7')
    })
  })

  describe('basic variable write', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('setvar-basic'),
        matcher: { rule: "PathPrefix('/setvar/basic')", priority: 50 },
        middlewares: [
          {
            type: 'set_variable',
            config: {
              name: 'tag',
              stage: 'request',
              expression: "MethodValue() + '-' + QueryValue('id')",
            },
          },
          {
            type: 'request_headers',
            config: {
              name: 'x-tag',
              action: 'set',
              expression: 'tag',
            },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('writes CEL variable and reuses it in following middleware', async () => {
      const { body } = await getJson(proxyPort, '/setvar/basic/test?id=9', { method: 'POST' })
      assert.strictEqual(body.headers['x-tag'], 'POST-9')
    })
  })

  describe('rule condition', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('setvar-rule'),
        matcher: { rule: "PathPrefix('/setvar/rule')", priority: 50 },
        middlewares: [
          {
            type: 'set_variable',
            config: {
              name: 'trace_id',
              stage: 'request',
              expression: "'trace-' + QueryValue('id')",
              rule: "Query('apply', '1')",
            },
          },
          {
            type: 'request_headers',
            config: {
              name: 'x-trace-id',
              action: 'set_default',
              expression: 'trace_id',
            },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('sets dependent header when rule matches', async () => {
      const { body } = await getJson(proxyPort, '/setvar/rule/test?id=42&apply=1')
      assert.strictEqual(body.headers['x-trace-id'], 'trace-42')
    })

    it('keeps dependent header unset when rule does not match', async () => {
      const { body } = await getJson(proxyPort, '/setvar/rule/test?id=42')
      assert.strictEqual(body?.headers?.['x-trace-id'], undefined)
    })
  })

  describe('upstream_response stage', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('setvar-upstream-resp'),
        matcher: { rule: "PathPrefix('/setvar/upstream-response')", priority: 50 },
        middlewares: [
          {
            type: 'set_variable',
            config: {
              name: 'origin_path',
              stage: 'upstream_response',
              expression: "PathValue()",
            },
          },
          {
            type: 'response_headers',
            config: {
              name: 'x-origin-path',
              action: 'set',
              expression: 'origin_path',
            },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('sets variable in upstream_response stage and uses it in response stage', async () => {
      const res = await proxyFetch(proxyPort, '/setvar/upstream-response/demo')
      await res.text()
      assertHeader(res, 'x-origin-path', '/setvar/upstream-response/demo')
    })

    it('can read upstream response status/header in expression', async () => {
      upstream.setHandler((_req, res) => {
        res.setHeader('x-from-upstream', 'uv')
        res.statusCode = 202
        res.end('ok')
      })

      const id = nextRouteId('setvar-upstream-meta')
      const clean = withRoute(server, {
        id,
        matcher: { rule: "PathPrefix('/setvar/upstream-meta')", priority: 50 },
        middlewares: [
          {
            type: 'set_variable',
            config: {
              name: 'up_meta',
              stage: 'upstream_response',
              expression: "string(ResponseStatusValue()) + '|' + ResponseHeaderValue('x-from-upstream')",
            },
          },
          {
            type: 'response_headers',
            config: {
              name: 'x-up-meta',
              action: 'set',
              expression: 'up_meta',
            },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      })

      const res = await proxyFetch(proxyPort, '/setvar/upstream-meta/test')
      await res.text()
      assert.strictEqual(res.status, 202)
      assertHeader(res, 'x-up-meta', '202|uv')

      clean()
      upstream.resetHandler()
    })
  })

  describe('response stage', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('setvar-response'),
        matcher: { rule: "PathPrefix('/setvar/response')", priority: 50 },
        middlewares: [
          {
            type: 'set_variable',
            config: {
              name: 'resp_tag',
              stage: 'response',
              expression: "'resp-' + PathValue()",
            },
          },
          {
            type: 'response_headers',
            config: {
              name: 'x-resp-tag',
              action: 'set',
              expression: 'resp_tag',
            },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('sets variable in response stage and uses it in response header expression', async () => {
      const res = await proxyFetch(proxyPort, '/setvar/response/demo')
      await res.text()
      assertHeader(res, 'x-resp-tag', 'resp-/setvar/response/demo')
    })

    it('respects rule in response stage', async () => {
      const id = nextRouteId('setvar-response-rule')
      const clean = withRoute(server, {
        id,
        matcher: { rule: "PathPrefix('/setvar/response-rule')", priority: 80 },
        middlewares: [
          {
            type: 'set_variable',
            config: {
              name: 'resp_gate',
              stage: 'response',
              expression: "'hit'",
              rule: "Query('apply', '1')",
            },
          },
          {
            type: 'response_headers',
            config: {
              name: 'x-resp-gate',
              action: 'set_default',
              expression: 'resp_gate',
            },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      })

      const res1 = await proxyFetch(proxyPort, '/setvar/response-rule/test?apply=1')
      await res1.text()
      assertHeader(res1, 'x-resp-gate', 'hit')

      const res2 = await proxyFetch(proxyPort, '/setvar/response-rule/test')
      await res2.text()
      assert.strictEqual(res2.headers.get('x-resp-gate'), null)

      clean()
    })
  })
})
