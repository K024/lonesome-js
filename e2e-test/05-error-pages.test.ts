import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { LonesomeServer } from '../dist/index.js'
import type { LonesomeServer as LonesomeServerType } from '../dist/index.js'
import { createDynamicUpstream } from './helpers/upstream.js'
import { nextRouteId, tcpUpstream, withRoute } from './helpers/routes.js'
import { proxyFetch, requestWithCustomHost } from './helpers/request.js'
import { pickFreePort, sleep } from './helpers/proxy.js'

let server: LonesomeServerType
let upstream: ReturnType<typeof createDynamicUpstream>
let port: number
let cleanup: Array<() => void> = []

before(async () => {
  upstream = createDynamicUpstream()
  await upstream.start()
  port = await pickFreePort()
  server = new LonesomeServer()
  server.start({
    listeners: [{ kind: 'tcp', addr: `127.0.0.1:${port}` }],
  })
  await sleep(600)
})

after(async () => {
  cleanup.forEach((fn) => fn())
  try {
    server?.stop()
  } catch {
    // ok
  }
  await upstream.stop()
})

describe('error pages: fail_to_proxy (404)', () => {
  it('renders the registered page for an unmatched route', async () => {
    server.updateErrorPage({ id: 'g404', status: 404, body: 'GENERIC-NOT-FOUND' })
    const res = await proxyFetch(port, '/no-such-route')
    assert.strictEqual(res.status, 404)
    assert.strictEqual(await res.text(), 'GENERIC-NOT-FOUND')
  })

  it('gates by CEL matcher and priority', async () => {
    server.updateErrorPage({
      id: 'api404',
      status: 404,
      priority: 10,
      matcher: "PathPrefix('/api')",
      body: 'API-NOT-FOUND',
    })

    const generic = await proxyFetch(port, '/no-such-route')
    assert.strictEqual(generic.status, 404)
    assert.strictEqual(await generic.text(), 'GENERIC-NOT-FOUND')

    const api = await proxyFetch(port, '/api/whatever')
    assert.strictEqual(api.status, 404)
    assert.strictEqual(await api.text(), 'API-NOT-FOUND')
  })

  it('serves an unconditional page via status_override and headers', async () => {
    server.updateErrorPage({
      id: 'so502',
      status: 502,
      statusOverride: 200,
      headers: { 'Retry-After': '120' },
      body: 'MAINTENANCE',
    })
    const id = nextRouteId('errp-502')
    cleanup.push(withRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/downstream')", priority: 50 },
      middlewares: [],
      upstreams: tcpUpstream(1), // closed port -> 502
    }))

    const res = await proxyFetch(port, '/downstream')
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.headers.get('retry-after'), '120')
    assert.strictEqual(await res.text(), 'MAINTENANCE')
  })
})

describe('error pages: CEL body_expression + ErrorStatusValue', () => {
  it('evaluates the body expression with the generated status', async () => {
    server.updateErrorPage({
      id: 'be418',
      status: 418,
      bodyExpression: "'code=' + string(ErrorStatusValue())",
    })
    const id = nextRouteId('errp-be')
    cleanup.push(withRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/teapot')", priority: 50 },
      middlewares: [{ type: 'respond', config: { status: 418 } }],
      upstreams: tcpUpstream(upstream.port),
    }))

    const res = await proxyFetch(port, '/teapot')
    assert.strictEqual(res.status, 418)
    assert.strictEqual(await res.text(), 'code=418')
  })
})

describe('error pages: middleware wiring', () => {
  it('renders a page for a bare respond error status', async () => {
    server.updateErrorPage({ id: 'p503', status: 503, body: 'PAGE-503' })
    const id = nextRouteId('errp-503-bare')
    cleanup.push(withRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/bare')", priority: 50 },
      middlewares: [{ type: 'respond', config: { status: 503 } }],
      upstreams: tcpUpstream(upstream.port),
    }))

    const res = await proxyFetch(port, '/bare')
    assert.strictEqual(res.status, 503)
    assert.strictEqual(await res.text(), 'PAGE-503')
  })

  it('does not override explicit respond content', async () => {
    const id = nextRouteId('errp-503-explicit')
    cleanup.push(withRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/explicit')", priority: 50 },
      middlewares: [{
        type: 'respond',
        config: { status: 503, body: 'EXPLICIT', content_type: 'text/plain; charset=utf-8' },
      }],      upstreams: tcpUpstream(upstream.port),
    }))

    const res = await proxyFetch(port, '/explicit')
    assert.strictEqual(res.status, 503)
    assert.strictEqual(await res.text(), 'EXPLICIT')
  })

  it('renders a page for basic_auth 401 while keeping WWW-Authenticate', async () => {
    server.updateErrorPage({ id: 'p401', status: 401, body: 'AUTH-PAGE' })
    const id = nextRouteId('errp-401')
    cleanup.push(withRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/private')", priority: 50 },
      middlewares: [{
        type: 'basic_auth',
        config: {
          realm: 'Test Realm',
          users: [{ name: 'alice', password_hash: '$2b$12$4VnKjQn9C0VX0vQ0V0vQ0uQ0V0vQ0V0vQ0V0vQ0V0vQ0V0vQ0V0' }],
        },
      }],
      upstreams: tcpUpstream(upstream.port),
    }))

    const res = await proxyFetch(port, '/private')
    assert.strictEqual(res.status, 401)
    assert.match(String(res.headers.get('www-authenticate') ?? ''), /Basic realm="Test Realm"/)
    assert.strictEqual(await res.text(), 'AUTH-PAGE')
  })

  it('renders a page for rate_limit 429 while keeping X-RateLimit headers', async () => {
    server.updateErrorPage({ id: 'p429', status: 429, body: 'LIMIT-PAGE' })
    const id = nextRouteId('errp-429')
    cleanup.push(withRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/limited')", priority: 50 },
      middlewares: [{
        type: 'rate_limit',
        config: { mode: 'remote_ip', max_rps: 1, include_headers: true },
      }],
      upstreams: tcpUpstream(upstream.port),
    }))

    // allowance is max_rps * window; exceed it to trigger 429
    let lastStatus = 200
    for (let i = 0; i < 15; i++) {
      const res = await proxyFetch(port, '/limited')
      await res.text()
      lastStatus = res.status
    }
    assert.strictEqual(lastStatus, 429)
    const limited = await proxyFetch(port, '/limited')
    assert.strictEqual(limited.status, 429)
    assert.strictEqual(limited.headers.get('x-ratelimit-limit'), '10')
    assert.strictEqual(await limited.text(), 'LIMIT-PAGE')
  })
})

describe('error pages: lifecycle and status', () => {
  it('reverts to the default error page after removeErrorPage', async () => {
    server.updateErrorPage({ id: 'rm504', status: 504, body: 'TMP-PAGE' })
    const id = nextRouteId('errp-504')
    cleanup.push(withRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/removed')", priority: 50 },
      middlewares: [{ type: 'respond', config: { status: 504 } }],
      upstreams: tcpUpstream(upstream.port),
    }))

    const before = await proxyFetch(port, '/removed')
    assert.strictEqual(await before.text(), 'TMP-PAGE')

    assert.strictEqual(server.removeErrorPage('rm504'), true)
    assert.strictEqual(server.removeErrorPage('rm504'), false)

    const after = await proxyFetch(port, '/removed')
    assert.strictEqual(after.status, 504)
    assert.strictEqual(await after.text(), '')
  })

  it('reports the error page count via status()', () => {
    const st = server.status()
    assert.strictEqual(typeof st.errorPageCount, 'number')
    assert.ok(st.errorPageCount > 0)
  })

  it('rejects invalid error page configs', () => {
    assert.throws(
      () => server.updateErrorPage({ id: 'bad1', status: 200, body: 'x' }),
      /within \[400, 599\]/,
    )
    assert.throws(
      () => server.updateErrorPage({ id: 'bad2', status: 500, body: 'x', bodyExpression: "'y'" }),
      /cannot both be set/,
    )
    assert.throws(
      () => server.updateErrorPage({ id: 'bad3', status: 500, matcher: 'Path(' }),
      /matcher/,
    )
    assert.throws(
      () => server.updateErrorPage({ id: 'bad4', status: 500, headers: { 'Bad Header': 'x' } }),
      /header/,
    )
  })
})

describe('error pages: status spec ranges', () => {
  it('serves a page for every code in a range spec', async () => {
    server.updateErrorPage({ id: 'range405', status: '405-406', body: 'RANGE-PAGE' })

    for (const status of [405, 406]) {
      const id = nextRouteId(`errp-range-${status}`)
      cleanup.push(withRoute(server, {
        id,
        matcher: { rule: `PathPrefix('/range-${status}')`, priority: 50 },
        middlewares: [{ type: 'respond', config: { status } }],
        upstreams: tcpUpstream(upstream.port),
      }))

      const res = await proxyFetch(port, `/range-${status}`)
      assert.strictEqual(res.status, status)
      assert.strictEqual(await res.text(), 'RANGE-PAGE')
    }
  })

  it('rejects malformed status specs', () => {
    assert.throws(
      () => server.updateErrorPage({ id: 'bad-spec-1', status: '400-300', body: 'x' }),
      /reversed/,
    )
    assert.throws(
      () => server.updateErrorPage({ id: 'bad-spec-2', status: '404-999', body: 'x' }),
      /within \[400, 599\]/,
    )
    assert.throws(
      () => server.updateErrorPage({ id: 'bad-spec-3', status: 'abc', body: 'x' }),
      /bad code/,
    )
  })
})

describe('error pages: dynamic content via matcher context', () => {
  it('lets the matcher use request context beyond path', async () => {
    server.updateErrorPage({
      id: 'host404',
      status: 404,
      priority: 5,
      matcher: "HostValue() == 'special.test'",
      body: 'SPECIAL-HOST-404',
    })
    const special = await requestWithCustomHost(port, '/no-route', 'special.test')
    assert.strictEqual(special.response.statusCode, 404)
    assert.strictEqual(special.body, 'SPECIAL-HOST-404')

    const other = await proxyFetch(port, '/no-route')
    assert.strictEqual(await other.text(), 'GENERIC-NOT-FOUND')
  })
})

describe('upstream 5xx responses', () => {
  before(() => {
    upstream.setHandler((_req, res) => {
      res.statusCode = 503
      res.setHeader('content-type', 'text/plain')
      res.end('upstream-error-body')
    })
  })
  after(() => upstream.resetHandler())

  it('forwards an upstream 5xx verbatim even when a page exists for that status', async () => {
    server.updateErrorPage({ id: 'u503', status: 503, body: 'PAGE-503' })
    const id = nextRouteId('errp-upstream-503')
    cleanup.push(withRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/upstream/503')", priority: 50 },
      middlewares: [],
      upstreams: tcpUpstream(upstream.port),
    }))

    const res = await proxyFetch(port, '/upstream/503')
    assert.strictEqual(res.status, 503)
    assert.strictEqual(await res.text(), 'upstream-error-body')
  })
})

describe('rewrite_error_page middleware', () => {
  before(() => {
    // distinct upstream status per path so tests never collide in the shared store
    upstream.setHandler((req, res) => {
      const p = req.url ?? ''
      let status = 503
      for (const s of [504, 505, 506, 507, 508]) {
        if (p.startsWith(`/rewrite/${s}`)) {
          status = s
          break
        }
      }
      res.statusCode = status
      res.setHeader('content-type', 'text/plain')
      if (p.startsWith('/rewrite/505')) {
        res.end() // error response with NO body
      } else {
        res.end(`upstream-${status}`)
      }
    })
  })
  after(() => upstream.resetHandler())

  it('replaces an upstream 5xx with the rendered error page', async () => {
    server.updateErrorPage({ id: 'rw504', status: 504, body: 'REWRITTEN-PAGE' })
    const id = nextRouteId('errp-rw')
    cleanup.push(withRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/rewrite/504')", priority: 50 },
      middlewares: [{ type: 'rewrite_error_page', config: {} }],
      upstreams: tcpUpstream(upstream.port),
    }))

    const res = await proxyFetch(port, '/rewrite/504')
    assert.strictEqual(res.status, 504)
    assert.strictEqual(await res.text(), 'REWRITTEN-PAGE')
  })

  it('intercepts only the statuses in the spec', async () => {
    server.updateErrorPage({ id: 'rw505', status: 505, body: 'PAGE-505' })
    const id = nextRouteId('errp-rw-spec')
    cleanup.push(withRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/rewrite/505')", priority: 50 },
      middlewares: [{ type: 'rewrite_error_page', config: { status: '502' } }],
      upstreams: tcpUpstream(upstream.port),
    }))

    // upstream returns 505, middleware only intercepts 502 -> passthrough
    const res = await proxyFetch(port, '/rewrite/505')
    assert.strictEqual(res.status, 505)
    assert.strictEqual(await res.text(), '')
  })

  it('does not replace a body-less upstream error (passed through unchanged)', async () => {
    server.updateErrorPage({ id: 'rw505nb', status: 505, priority: 100, body: 'NO-BODY-PAGE' })
    const id = nextRouteId('errp-rw-nobody')
    cleanup.push(withRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/rewrite/505')", priority: 50 },
      middlewares: [{ type: 'rewrite_error_page', config: {} }],
      upstreams: tcpUpstream(upstream.port),
    }))

    // upstream returns 505 with an empty body: pingora never calls the body
    // filter, so the page cannot be injected; the empty upstream error is
    // passed through unchanged instead of corrupting the framing.
    const res = await proxyFetch(port, '/rewrite/505')
    assert.strictEqual(res.status, 505)
    assert.strictEqual(await res.text(), '')
  })

  it('is gated by the CEL rule', async () => {
    server.updateErrorPage({ id: 'rw506', status: 506, body: 'RULE-PAGE' })
    const id = nextRouteId('errp-rw-rule')
    cleanup.push(withRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/rewrite/506')", priority: 50 },
      middlewares: [{
        type: 'rewrite_error_page',
        config: { rule: "PathPrefix('/rewrite/506/hit')" },
      }],
      upstreams: tcpUpstream(upstream.port),
    }))

    const hit = await proxyFetch(port, '/rewrite/506/hit')
    assert.strictEqual(hit.status, 506)
    assert.strictEqual(await hit.text(), 'RULE-PAGE')

    const miss = await proxyFetch(port, '/rewrite/506/miss')
    assert.strictEqual(miss.status, 506)
    assert.strictEqual(await miss.text(), 'upstream-506')
  })

  it('passes through when the store has no matching page', async () => {
    const id = nextRouteId('errp-rw-nopage')
    cleanup.push(withRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/rewrite/507')", priority: 50 },
      middlewares: [{ type: 'rewrite_error_page', config: {} }],
      upstreams: tcpUpstream(upstream.port),
    }))

    const res = await proxyFetch(port, '/rewrite/507')
    assert.strictEqual(res.status, 507)
    assert.strictEqual(await res.text(), 'upstream-507')
  })

  it('honors the page status_override and headers', async () => {
    server.updateErrorPage({
      id: 'rw508',
      status: 508,
      statusOverride: 200,
      headers: { 'X-Rewritten': 'yes' },
      body: 'OVERRIDDEN-PAGE',
    })
    const id = nextRouteId('errp-rw-ovr')
    cleanup.push(withRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/rewrite/508')", priority: 50 },
      middlewares: [{ type: 'rewrite_error_page', config: {} }],
      upstreams: tcpUpstream(upstream.port),
    }))

    const res = await proxyFetch(port, '/rewrite/508')
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.headers.get('x-rewritten'), 'yes')
    assert.strictEqual(await res.text(), 'OVERRIDDEN-PAGE')
  })
})

describe('error pages: connect failure', () => {
  it('renders the page for a read timeout after a successful connect (502)', async () => {
    server.updateErrorPage({ id: 'rt502', status: 502, priority: 100, body: 'TIMEOUT-PAGE' })

    // a blackhole upstream: accepts the connection but never responds
    const net = await import('node:net')
    const blackhole = net.createServer(() => {})
    await new Promise<void>((resolve) => blackhole.listen(0, '127.0.0.1', resolve))
    const blackholePort = (blackhole.address() as { port: number }).port

    const id = nextRouteId('errp-rt')
    cleanup.push(withRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/read-timeout')", priority: 50 },
      middlewares: [],
      upstreams: [{
        kind: 'tcp',
        address: `127.0.0.1:${blackholePort}`,
        tls: false,
        sni: '',
        weight: 1,
        readTimeoutMs: 300,
      }],
    }))

    try {
      const res = await proxyFetch(port, '/read-timeout')
      assert.strictEqual(res.status, 502)
      assert.strictEqual(await res.text(), 'TIMEOUT-PAGE')
    } finally {
      blackhole.close()
    }
  })
})
