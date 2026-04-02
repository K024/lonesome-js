import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startProxy } from './helpers/proxy.js'
import { createDynamicUpstream } from './helpers/upstream.js'
import { nextRouteId, tcpUpstream, addRoute, removeRoute } from './helpers/routes.js'
import { assertStatus, proxyFetch } from './helpers/request.js'
import type { DenaliServer } from '../dist/index.js'

let server: DenaliServer
let proxyPort: number
const upstream1 = createDynamicUpstream()
const upstream2 = createDynamicUpstream()

before(async () => {
  await upstream1.start()
  await upstream2.start()
  ;({ server, port: proxyPort } = await startProxy())
})

after(async () => {
  server.stop()
  await upstream1.stop()
  await upstream2.stop()
})

describe('route management', () => {
  it('status() shows running=true after start', () => {
    assert.strictEqual(server.status().running, true)
  })

  it('addOrUpdate creates a new route that immediately matches', async () => {
    const id = nextRouteId('mgmt-new')
    addRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/mgmt/new')", priority: 50 },
      middlewares: [],
      upstreams: tcpUpstream(upstream1.port),
    })
    await assertStatus(proxyPort, '/mgmt/new/test', 200)
    removeRoute(server, id)
  })

  it('status() routeCount increases after addOrUpdate', () => {
    const before = server.status().routeCount
    const id = nextRouteId('mgmt-count')
    addRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/mgmt/count')", priority: 50 },
      middlewares: [],
      upstreams: tcpUpstream(upstream1.port),
    })
    assert.strictEqual(server.status().routeCount, before + 1)
    removeRoute(server, id)
  })

  it('status() routeCount decreases after remove', () => {
    const id = nextRouteId('mgmt-dec')
    addRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/mgmt/dec')", priority: 50 },
      middlewares: [],
      upstreams: tcpUpstream(upstream1.port),
    })
    const before = server.status().routeCount
    removeRoute(server, id)
    assert.strictEqual(server.status().routeCount, before - 1)
  })

  it('addOrUpdate hot-updates middlewares (adds Respond short-circuit)', async () => {
    const id = nextRouteId('mgmt-upd')
    addRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/mgmt/upd')", priority: 50 },
      middlewares: [],
      upstreams: tcpUpstream(upstream1.port),
    })
    await assertStatus(proxyPort, '/mgmt/upd', 200)

    // Hot-update: add Respond middleware returning 418
    addRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/mgmt/upd')", priority: 50 },
      middlewares: [{ type: 'respond', config: { status: 418, body: 'teapot' } }],
      upstreams: tcpUpstream(upstream1.port),
    })
    await assertStatus(proxyPort, '/mgmt/upd', 418)
    removeRoute(server, id)
  })

  it('addOrUpdate hot-updates upstream (switches to upstream2)', async () => {
    const id = nextRouteId('mgmt-us')
    upstream2.setHandler((_req, res) => {
      res.setHeader('x-from', 'upstream2')
      res.statusCode = 200
      res.end('ok')
    })

    addRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/mgmt/us')", priority: 50 },
      middlewares: [],
      upstreams: tcpUpstream(upstream1.port),
    })
    {
      const res = await proxyFetch(proxyPort, '/mgmt/us')
      await res.text()
      assert.strictEqual(res.headers.get('x-from'), null)
    }

    // switch to upstream2
    addRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/mgmt/us')", priority: 50 },
      middlewares: [],
      upstreams: tcpUpstream(upstream2.port),
    })
    {
      const res = await proxyFetch(proxyPort, '/mgmt/us')
      await res.text()
      assert.strictEqual(res.headers.get('x-from'), 'upstream2')
    }

    upstream2.resetHandler()
    removeRoute(server, id)
  })

  it('remove returns true for an existing route', () => {
    const id = nextRouteId('mgmt-rm')
    addRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/mgmt/rm')", priority: 50 },
      middlewares: [],
      upstreams: tcpUpstream(upstream1.port),
    })
    assert.strictEqual(removeRoute(server, id), true)
  })

  it('route no longer matches after remove', async () => {
    const id = nextRouteId('mgmt-gone')
    addRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/mgmt/gone')", priority: 50 },
      middlewares: [],
      upstreams: tcpUpstream(upstream1.port),
    })
    await assertStatus(proxyPort, '/mgmt/gone', 200)
    removeRoute(server, id)
    await assertStatus(proxyPort, '/mgmt/gone', 404)
  })

  it('remove returns false for a non-existent route', () => {
    assert.strictEqual(removeRoute(server, 'this-route-does-not-exist'), false)
  })
})
