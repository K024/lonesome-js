import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startProxy } from './helpers/proxy.js'
import { createDynamicUpstream } from './helpers/upstream.js'
import { nextRouteId, tcpUpstream, withRoute } from './helpers/routes.js'
import { getJson, assertStatus, assertHeader, proxyFetch } from './helpers/request.js'
import type { DenaliServer } from '../dist/index.js'

let server: DenaliServer
let proxyPort: number
const upstream = createDynamicUpstream()
let cleanup: () => void

before(async () => {
  await upstream.start()
  ;({ server, port: proxyPort } = await startProxy())
  cleanup = withRoute(server, {
    id: nextRouteId('basic'),
    matcher: { rule: "PathPrefix('/basic')", priority: 10 },
    middlewares: [],
    upstreams: tcpUpstream(upstream.port),
    loadBalancer: { algorithm: 'round_robin' },
  })
})

after(async () => {
  cleanup()
  server.stop()
  await upstream.stop()
})

describe('basic proxy', () => {
  it('passes path and query string to upstream', async () => {
    const { body } = await getJson(proxyPort, '/basic/hello?foo=bar&baz=1')
    assert.strictEqual(body.url, '/basic/hello?foo=bar&baz=1')
  })

  it('passes GET method', async () => {
    const { body } = await getJson(proxyPort, '/basic/method')
    assert.strictEqual(body.method, 'GET')
  })

  it('passes POST method', async () => {
    const { body } = await getJson(proxyPort, '/basic/method', { method: 'POST' })
    assert.strictEqual(body.method, 'POST')
  })

  it('passes PUT method', async () => {
    const { body } = await getJson(proxyPort, '/basic/method', { method: 'PUT' })
    assert.strictEqual(body.method, 'PUT')
  })

  it('passes DELETE method', async () => {
    const { body } = await getJson(proxyPort, '/basic/method', { method: 'DELETE' })
    assert.strictEqual(body.method, 'DELETE')
  })

  it('passes request body to upstream', async () => {
    const payload = JSON.stringify({ hello: 'world' })
    const { body } = await getJson(proxyPort, '/basic/body', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    })
    assert.strictEqual(body.body, payload)
  })

  it('passes upstream 201 response status', async () => {
    upstream.setHandler((_req, res) => { res.statusCode = 201; res.end() })
    await assertStatus(proxyPort, '/basic/status', 201)
    upstream.resetHandler()
  })

  it('passes upstream 404 response status', async () => {
    upstream.setHandler((_req, res) => { res.statusCode = 404; res.end() })
    await assertStatus(proxyPort, '/basic/status', 404)
    upstream.resetHandler()
  })

  it('passes upstream custom response headers', async () => {
    upstream.setHandler((_req, res) => {
      res.setHeader('x-custom-header', 'test-value')
      res.statusCode = 200
      res.end('ok')
    })
    const res = await proxyFetch(proxyPort, '/basic/headers')
    await res.text()
    assertHeader(res, 'x-custom-header', 'test-value')
    upstream.resetHandler()
  })
})
