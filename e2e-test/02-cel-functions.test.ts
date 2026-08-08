import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startProxy } from './helpers/proxy.js'
import { createDynamicUpstream } from './helpers/upstream.js'
import { nextRouteId, tcpUpstream, withRoute } from './helpers/routes.js'
import { proxyFetch, requestWithCustomHost, requestRawHttp } from './helpers/request.js'
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
  try {
    server?.stop()
  } catch {
    // ok: server may be undefined when before() failed
  }
  await upstream.stop()
})

describe('CEL functions with respond middleware', () => {
  before(() => {
    cleanups.push(withRoute(server, {
      id: nextRouteId('cel-funcs'),
      matcher: { rule: "PathPrefix('/cel/fn')", priority: 70 },
      middlewares: [
        {
          type: 'respond',
          config: {
            status: 200,
            content_type: 'text/plain; charset=utf-8',
            body_expression:
              "HostValue() + '|' + MethodValue() + '|' + PathValue() + '|' + QueryValue('id') + '|' + HeaderValue('x-demo')",
          },
        },
      ],
      upstreams: tcpUpstream(upstream.port),
    }))
  })

  it('supports HostValue/MethodValue/PathValue/QueryValue/HeaderValue', async () => {
    const { response, body } = await requestWithCustomHost(
      proxyPort,
      '/cel/fn/echo/path?id=42',
      'api.demo.local',
      {
        method: 'POST',
        headers: { 'x-demo': 'abc' },
      },
    )

    assert.strictEqual(response.statusCode, 200)
    assert.strictEqual(body, 'api.demo.local|POST|/cel/fn/echo/path|42|abc')
  })

  it('PathValue returns decoded path', async () => {
    const res = await proxyFetch(proxyPort, '/cel/fn/%E4%BD%A0%E5%A5%BD')
    const text = await res.text()
    assert.strictEqual(text, '127.0.0.1|GET|/cel/fn/你好||')
  })
})

describe('CEL response functions', () => {
  before(() => {
    upstream.setHandler((_req, res) => {
      res.setHeader('x-from-upstream', 'up-v')
      res.statusCode = 201
      res.end('upstream')
    })

    cleanups.push(withRoute(server, {
      id: nextRouteId('cel-funcs-resp'),
      matcher: { rule: "PathPrefix('/cel/respfn')", priority: 70 },
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
    }))
  })

  after(() => {
    upstream.resetHandler()
  })

  it('supports ResponseStatusValue and ResponseHeaderValue', async () => {
    const res = await proxyFetch(proxyPort, '/cel/respfn/test')
    await res.text()
    assert.strictEqual(res.status, 201)
    assert.strictEqual(res.headers.get('x-up-meta'), '201|up-v')
  })
})

describe('CEL standard utility functions', () => {
  before(() => {
    cleanups.push(withRoute(server, {
      id: nextRouteId('cel-utils'),
      matcher: { rule: "PathPrefix('/cel/utils')", priority: 70 },
      middlewares: [
        {
          type: 'respond',
          config: {
            status: 200,
            content_type: 'text/plain; charset=utf-8',
            body_expression:
              "(now() >= RequestTime() ? 'true' : 'false') + '|' + (random() >= 0.0 && random() < 1.0 ? 'true' : 'false') + '|' + string(RequestTime())",
          },
        },
      ],
      upstreams: tcpUpstream(upstream.port),
    }))
  })

  it('supports now(), random(), and session RequestTime()', async () => {
    const before = Date.now()
    const res = await proxyFetch(proxyPort, '/cel/utils/time-random')
    const text = await res.text()
    const after = Date.now()

    assert.strictEqual(res.status, 200)
    const [nowAfterRequestTime, randomInRange, requestTime] = text.split('|')
    assert.strictEqual(nowAfterRequestTime, 'true')
    assert.strictEqual(randomInRange, 'true')

    assert.match(requestTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+00:00$/)
    const requestTimeMs = Date.parse(requestTime)
    assert.ok(Number.isFinite(requestTimeMs), `RequestTime() is not parseable: ${requestTime}`)
    assert.ok(
      requestTimeMs >= before - 1000 && requestTimeMs <= after + 1000,
      `RequestTime() ${requestTime} should be close to the request window`,
    )
  })
})

describe('CEL predicates in rule fields', () => {
  describe('request_headers rule with HeaderRegexp and QueryRegexp', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('cel-rule-rqh'),
        matcher: { rule: "PathPrefix('/cel/rule/rqh')", priority: 70 },
        middlewares: [
          {
            type: 'request_headers',
            config: {
              name: 'x-rule-hit',
              action: 'set',
              value: '1',
              rule: "HeaderRegexp('x-user', '^u[0-9]+$') && QueryRegexp('id', '^[0-9]{2}$')",
            },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('applies middleware when CEL rule matches', async () => {
      const res = await proxyFetch(proxyPort, '/cel/rule/rqh/test?id=42', {
        headers: { 'x-user': 'u9' },
      })
      const body = JSON.parse(await res.text())
      assert.strictEqual(body.headers['x-rule-hit'], '1')
    })

    it('does not apply middleware when CEL rule misses', async () => {
      const res = await proxyFetch(proxyPort, '/cel/rule/rqh/test?id=xx', {
        headers: { 'x-user': 'u9' },
      })
      const body = JSON.parse(await res.text())
      assert.strictEqual(body.headers['x-rule-hit'], undefined)
    })
  })

  describe('redirect rule with ClientIP CIDR check', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('cel-rule-redirect'),
        matcher: { rule: "PathPrefix('/cel/rule/redir')", priority: 70 },
        middlewares: [
          {
            type: 'redirect',
            config: {
              code: 302,
              target_mode: 'static',
              target: 'https://example.com/cel-ip',
              rule: "ClientIP('127.0.0.0/8')",
            },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('redirects when ClientIP() rule matches localhost CIDR', async () => {
      const { response } = await requestRawHttp(proxyPort, '/cel/rule/redir/test')
      assert.strictEqual(response.statusCode, 302)
      assert.strictEqual(String(response.headers.location ?? ''), 'https://example.com/cel-ip')
    })
  })
})

describe('Host wildcard matching', () => {
  before(() => {
    cleanups.push(withRoute(server, {
      id: nextRouteId('cel-host-wildcard'),
      matcher: { rule: "Host('*.example.com')", priority: 60 },
      middlewares: [
        {
          type: 'respond',
          config: {
            status: 200,
            content_type: 'text/plain; charset=utf-8',
            body_expression: "'wildcard'",
          },
        },
      ],
      upstreams: tcpUpstream(upstream.port),
    }))

    cleanups.push(withRoute(server, {
      id: nextRouteId('cel-host-exact'),
      matcher: { rule: "Host('exact.example.com')", priority: 90 },
      middlewares: [
        {
          type: 'respond',
          config: {
            status: 200,
            content_type: 'text/plain; charset=utf-8',
            body_expression: "'exact'",
          },
        },
      ],
      upstreams: tcpUpstream(upstream.port),
    }))
  })

  it('Host("*.example.com") matches a single subdomain label', async () => {
    const { response, body } = await requestWithCustomHost(proxyPort, '/', 'api.example.com')
    assert.strictEqual(response.statusCode, 200)
    assert.strictEqual(body, 'wildcard')
  })

  it('Host("*.example.com") does not match the apex domain', async () => {
    const { response } = await requestWithCustomHost(proxyPort, '/', 'example.com')
    assert.strictEqual(response.statusCode, 404)
  })

  it('Host("*.example.com") does not match multi-label subdomains', async () => {
    const { response } = await requestWithCustomHost(proxyPort, '/', 'a.b.example.com')
    assert.strictEqual(response.statusCode, 404)
  })

  it('Host("*.example.com") does not match unrelated hosts', async () => {
    const { response } = await requestWithCustomHost(proxyPort, '/', 'other.com')
    assert.strictEqual(response.statusCode, 404)
  })

  it('exact Host() still works and wins over the wildcard by priority', async () => {
    const { response, body } = await requestWithCustomHost(proxyPort, '/', 'exact.example.com')
    assert.strictEqual(response.statusCode, 200)
    assert.strictEqual(body, 'exact')
  })
})
