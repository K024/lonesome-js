import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startProxy } from './helpers/proxy.js'
import { startVirtualUpstream } from './helpers/virtual.js'
import { nextRouteId, virtualUpstream, withRoute } from './helpers/routes.js'
import { proxyFetch } from './helpers/request.js'
import type { LonesomeServer } from '../dist/index.js'

const VIRTUAL_JS_KEY = 'test-vjs'

let server: LonesomeServer
let proxyPort: number
const cleanups: Array<() => void> = []
let vjsStop: () => void

before(async () => {
  ;({ server, port: proxyPort } = await startProxy())
  const vjs = startVirtualUpstream(VIRTUAL_JS_KEY)
  vjsStop = () => vjs.stop()
  cleanups.push(withRoute(server, {
    id: nextRouteId('vjs'),
    matcher: { rule: "PathPrefix('/vjs')", priority: 50 },
    middlewares: [],
    upstreams: virtualUpstream(VIRTUAL_JS_KEY),
    loadBalancer: { algorithm: 'round_robin', maxIterations: 16 },
  }))
})

after(() => {
  cleanups.forEach((fn) => fn())
  vjsStop?.()
  server.stop()
})

describe('virtual_js upstream', () => {
  it('basic request reaches virtual handler', async () => {
    const res = await proxyFetch(proxyPort, '/vjs/hello')
    const body = JSON.parse(await res.text())
    assert.strictEqual(res.status, 200)
    assert.strictEqual(body.upstream, 'virtual-js')
  })

  it('path and query are passed through correctly', async () => {
    const res = await proxyFetch(proxyPort, '/vjs/hello?x=1&y=2')
    const body = JSON.parse(await res.text())
    assert.strictEqual(body.url, '/vjs/hello?x=1&y=2')
  })

  it('request headers are passed through', async () => {
    const res = await proxyFetch(proxyPort, '/vjs/headers', { headers: { 'x-demo': 'virtual-test' } })
    const body = JSON.parse(await res.text())
    assert.strictEqual(body.headers['x-demo'], 'virtual-test')
  })

  it('method is passed through', async () => {
    const res = await proxyFetch(proxyPort, '/vjs/method', { method: 'POST' })
    const body = JSON.parse(await res.text())
    assert.strictEqual(body.method, 'POST')
  })

  it('concurrent requests are handled correctly without mixing', async () => {
    const paths = ['/vjs/c1', '/vjs/c2', '/vjs/c3', '/vjs/c4', '/vjs/c5']
    const results = await Promise.all(
      paths.map(async (path) => {
        const res = await proxyFetch(proxyPort, path)
        const body = JSON.parse(await res.text())
        return { path, url: body.url as string }
      }),
    )
    for (const { path, url } of results) {
      assert.strictEqual(url, path, `expected url=${path}, got ${url}`)
    }
  })

  it('requests fail after unregisterVirtualListener', async () => {
    const key = 'test-vjs-unreg'
    const vjs2 = startVirtualUpstream(key)
    const id = nextRouteId('vjs-unreg')
    const clean = withRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/vjs/unreg')", priority: 60 },
      middlewares: [],
      upstreams: virtualUpstream(key),
      loadBalancer: { algorithm: 'round_robin', maxIterations: 16 },
    })

    // Should work before unregister
    const res1 = await proxyFetch(proxyPort, '/vjs/unreg/test')
    await res1.text()
    assert.strictEqual(res1.status, 200)

    // Unregister and verify requests fail
    vjs2.stop()
    const res2 = await proxyFetch(proxyPort, '/vjs/unreg/test')
    await res2.text()
    assert.strictEqual(res2.status, 502)

    clean()
  })
})
