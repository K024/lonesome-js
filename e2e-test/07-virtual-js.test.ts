import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startProxy } from './helpers/proxy.js'
import { startVirtualUpstream } from './helpers/virtual.js'
import type { VirtualHandler } from './helpers/virtual.js'
import { nextRouteId, virtualUpstream, withRoute } from './helpers/routes.js'
import { proxyFetch } from './helpers/request.js'
import type { LonesomeServer } from '../dist/index.js'

const VIRTUAL_JS_KEY = 'test-vjs'

function markerVirtualHandler(marker: string): VirtualHandler {
  return (_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ marker }))
  }
}

async function collectMarkers(proxyPort: number, path: string, times: number): Promise<Set<string>> {
  const markers = new Set<string>()
  for (let i = 0; i < times; i++) {
    const res = await proxyFetch(proxyPort, path)
    const body = JSON.parse(await res.text())
    assert.strictEqual(res.status, 200)
    markers.add(body.marker)
  }
  return markers
}

let server: LonesomeServer
let proxyPort: number

before(async () => {
  ;({ server, port: proxyPort } = await startProxy())
})

after(() => {
  server.stop()
})

describe('virtual_js upstream', () => {
  describe('basic forwarding', () => {
    let stopVirtual: () => void
    let cleanupRoute: () => void

    before(() => {
      const vjs = startVirtualUpstream(VIRTUAL_JS_KEY)
      stopVirtual = () => vjs.stop()

      cleanupRoute = withRoute(server, {
        id: nextRouteId('vjs-basic'),
        matcher: { rule: "PathPrefix('/vjs')", priority: 50 },
        middlewares: [],
        upstreams: virtualUpstream(VIRTUAL_JS_KEY),
        loadBalancer: { algorithm: 'round_robin', maxIterations: 16 },
      })
    })

    after(() => {
      cleanupRoute()
      stopVirtual()
    })

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
  })

  describe('load balancing', () => {
    describe('same weight backends', () => {
      let stopA: () => void
      let stopB: () => void
      let cleanupRoute: () => void

      before(() => {
        const keyA = 'test-vjs-lb-same-a'
        const keyB = 'test-vjs-lb-same-b'
        const vjsA = startVirtualUpstream(keyA, markerVirtualHandler('A'))
        const vjsB = startVirtualUpstream(keyB, markerVirtualHandler('B'))
        stopA = () => vjsA.stop()
        stopB = () => vjsB.stop()

        cleanupRoute = withRoute(server, {
          id: nextRouteId('vjs-lb-same'),
          matcher: { rule: "PathPrefix('/vjs/lb/same')", priority: 60 },
          middlewares: [],
          upstreams: [
            { kind: 'virtual_js', address: keyA, tls: false, sni: '', weight: 1 },
            { kind: 'virtual_js', address: keyB, tls: false, sni: '', weight: 1 },
          ],
          loadBalancer: { algorithm: 'round_robin', maxIterations: 16 },
        })
      })

      after(() => {
        cleanupRoute()
        stopA()
        stopB()
      })

      it('round_robin should select both virtual_js backends', async () => {
        const markers = await collectMarkers(proxyPort, '/vjs/lb/same/check', 12)
        assert.ok(markers.has('A'))
        assert.ok(markers.has('B'))
      })
    })

    describe('different weight backends', () => {
      let stopA: () => void
      let stopB: () => void
      let cleanupRoute: () => void

      before(() => {
        const keyA = 'test-vjs-lb-diff-a'
        const keyB = 'test-vjs-lb-diff-b'
        const vjsA = startVirtualUpstream(keyA, markerVirtualHandler('A'))
        const vjsB = startVirtualUpstream(keyB, markerVirtualHandler('B'))
        stopA = () => vjsA.stop()
        stopB = () => vjsB.stop()

        cleanupRoute = withRoute(server, {
          id: nextRouteId('vjs-lb-diff'),
          matcher: { rule: "PathPrefix('/vjs/lb/diff')", priority: 60 },
          middlewares: [],
          upstreams: [
            { kind: 'virtual_js', address: keyA, tls: false, sni: '', weight: 1 },
            { kind: 'virtual_js', address: keyB, tls: false, sni: '', weight: 2 },
          ],
          loadBalancer: { algorithm: 'round_robin', maxIterations: 16 },
        })
      })

      after(() => {
        cleanupRoute()
        stopA()
        stopB()
      })

      it('round_robin can still select both virtual_js backends', async () => {
        const markers = await collectMarkers(proxyPort, '/vjs/lb/diff/check', 12)
        assert.ok(markers.has('A'))
        assert.ok(markers.has('B'))
      })
    })
  })

  describe('listener lifecycle', () => {
    let stopVirtual: () => void
    let cleanupRoute: () => void
    let stopped = false

    before(() => {
      const key = 'test-vjs-unreg'
      const vjs = startVirtualUpstream(key)
      stopVirtual = () => vjs.stop()
      stopped = false

      cleanupRoute = withRoute(server, {
        id: nextRouteId('vjs-unreg'),
        matcher: { rule: "PathPrefix('/vjs/unreg')", priority: 60 },
        middlewares: [],
        upstreams: virtualUpstream(key),
        loadBalancer: { algorithm: 'round_robin', maxIterations: 16 },
      })
    })

    after(() => {
      cleanupRoute()
      if (!stopped) {
        stopVirtual()
      }
    })

    it('requests fail after unregisterVirtualListener', async () => {
      const res1 = await proxyFetch(proxyPort, '/vjs/unreg/test')
      await res1.text()
      assert.strictEqual(res1.status, 200)

      stopVirtual()
      stopped = true

      const res2 = await proxyFetch(proxyPort, '/vjs/unreg/test')
      await res2.text()
      assert.strictEqual(res2.status, 502)
    })
  })
})
