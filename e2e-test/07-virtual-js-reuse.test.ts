import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LonesomeServer } from '../dist/index.js'
import { startProxy } from './helpers/proxy.js'
import { proxyFetch } from './helpers/request.js'
import { nextRouteId, virtualUpstream, withRoute } from './helpers/routes.js'
import { startVirtualUpstream } from './helpers/virtual.js'

const VIRTUAL_JS_KEY = 'test-vjs-reuse'

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
      id: nextRouteId('vjs-reuse'),
      matcher: { rule: "PathPrefix('/vjs/reuse')", priority: 70 },
      middlewares: [],
      upstreams: virtualUpstream(VIRTUAL_JS_KEY),
      loadBalancer: { algorithm: 'round_robin', maxIterations: 16 },
    })
  })

  after(() => {
    cleanupRoute()
    stopVirtual()
  })

  it('reuses an idle virtual upstream connection for sequential requests', async () => {
    const res1 = await proxyFetch(proxyPort, '/vjs/reuse/first')
    await res1.text()
    assert.strictEqual(res1.status, 200)

    const res2 = await proxyFetch(proxyPort, '/vjs/reuse/second')
    await res2.text()
    assert.strictEqual(res2.status, 200)

    assert.strictEqual(
      getOpenCount(),
      1,
      `expected one reused virtual upstream connection, got ${getOpenCount()} opens with connIds=${getOpenedConnIds().join(',')}`,
    )
    assert.ok(getOpenedConnIds()[0])
  })
})
