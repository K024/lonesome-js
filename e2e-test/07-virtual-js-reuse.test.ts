import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LonesomeServer } from '../dist/index.js'
import { startProxy } from './helpers/proxy.js'
import { proxyFetch } from './helpers/request.js'
import { nextRouteId, virtualUpstream, withRoute } from './helpers/routes.js'
import { startVirtualUpstream } from './helpers/virtual.js'

const VIRTUAL_JS_KEY = 'test-vjs-no-reuse'

let server: LonesomeServer
let proxyPort: number

before(async () => {
  ;({ server, port: proxyPort } = await startProxy())
})

after(() => {
  server.stop()
})

describe('virtual_js upstream reuse', () => {
  let cleanupRoute: () => void
  let stopVirtual: () => void
  let getOpenCount: () => number
  let getOpenedConnIds: () => string[]

  before(() => {
    const virtual = startVirtualUpstream(VIRTUAL_JS_KEY)
    stopVirtual = () => virtual.stop()
    getOpenCount = () => virtual.getOpenCount()
    getOpenedConnIds = () => virtual.getOpenedConnIds()

    cleanupRoute = withRoute(server, {
      id: nextRouteId('vjs-no-reuse'),
      matcher: { rule: "PathPrefix('/vjs/no-reuse')", priority: 70 },
      middlewares: [],
      upstreams: virtualUpstream(VIRTUAL_JS_KEY),
      loadBalancer: { algorithm: 'round_robin', maxIterations: 16 },
    })
  })

  after(() => {
    cleanupRoute()
    stopVirtual()
  })

  it('opens a fresh virtual upstream connection for each request', async () => {
    const res1 = await proxyFetch(proxyPort, '/vjs/no-reuse/first')
    await res1.text()
    assert.strictEqual(res1.status, 200)

    const res2 = await proxyFetch(proxyPort, '/vjs/no-reuse/second')
    await res2.text()
    assert.strictEqual(res2.status, 200)

    assert.strictEqual(
      getOpenCount(),
      2,
      `expected two virtual upstream open events, got ${getOpenCount()} with connIds=${getOpenedConnIds().join(',')}`,
    )
    assert.notStrictEqual(getOpenedConnIds()[0], getOpenedConnIds()[1])
  })
})
