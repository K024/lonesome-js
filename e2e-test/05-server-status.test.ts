import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { LonesomeServer } from '../dist/index.js'
import type { ServerStatus } from '../dist/index.js'
import { pickFreePort, sleep } from './helpers/proxy.js'
import { createDynamicUpstream } from './helpers/upstream.js'
import { nextRouteId, withRoute } from './helpers/routes.js'
import { proxyFetch } from './helpers/request.js'

let server: LonesomeServer
let upstream: ReturnType<typeof createDynamicUpstream>
let portA: number
let portB: number

function routeById(status: ServerStatus, id: string) {
  return status.routes.find((r) => r.id === id)
}

before(async () => {
  upstream = createDynamicUpstream()
  await upstream.start()
  portA = await pickFreePort()
  portB = await pickFreePort()
  server = new LonesomeServer()
  server.start({
    threads: 2,
    workStealing: true,
    listeners: [
      { kind: 'tcp', addr: `127.0.0.1:${portA}` },
      { kind: 'tcp', addr: `127.0.0.1:${portB}` },
    ],
  })
  await sleep(600)
})

after(async () => {
  try {
    server?.stop()
  } catch {
    // ok: server may be undefined when before() failed
  }
  await upstream.stop()
})

describe('server status reflection', () => {
  it('reflects an empty, not-running server before start', () => {
    const fresh = new LonesomeServer()
    const st = fresh.status()
    assert.strictEqual(st.running, false)
    assert.strictEqual(st.routeCount, 0)
    assert.strictEqual(st.threads, 0)
    assert.strictEqual(st.workStealing, false)
    assert.deepStrictEqual(st.listeners, [])
    assert.deepStrictEqual(st.routes, [])
  })

  it('reflects runtime config: running, threads, workStealing, listeners', () => {
    const st = server.status()
    assert.strictEqual(st.running, true)
    assert.strictEqual(st.threads, 2)
    assert.strictEqual(st.workStealing, true)
    assert.strictEqual(st.listeners.length, 2)
    assert.deepStrictEqual(
      st.listeners.map((l) => l.kind),
      ['tcp', 'tcp'],
    )
    assert.deepStrictEqual(
      st.listeners.map((l) => l.addr),
      [`127.0.0.1:${portA}`, `127.0.0.1:${portB}`],
    )
  })

  it('reflects registered routes and upstreams without health tracking by default', () => {
    const id = nextRouteId('status-r')
    const clean = withRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/status/up')", priority: 50 },
      middlewares: [],
      upstreams: [
        {
          kind: 'tcp',
          address: `127.0.0.1:${upstream.port}`,
          tls: false,
          sni: '',
          weight: 3,
        },
      ],
    })

    const route = routeById(server.status(), id)
    assert.ok(route)
    assert.strictEqual(route.rule, "PathPrefix('/status/up')")
    assert.strictEqual(route.priority, 50)
    assert.strictEqual(route.loadBalancer.algorithm, 'round_robin')
    assert.strictEqual(route.upstreams.length, 1)
    assert.strictEqual(route.upstreams[0].kind, 'tcp')
    assert.strictEqual(route.upstreams[0].address, `127.0.0.1:${upstream.port}`)
    assert.strictEqual(route.upstreams[0].weight, 3)
    // no health_check middleware configured -> not tracked (null or undefined)
    assert.ok(route.upstreams[0].health == null, 'health should be absent when not tracked')

    clean()
  })

  it('reports upstream health once a health_check middleware has observed traffic', async () => {
    const id = nextRouteId('status-hc')
    const clean = withRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/status/hc')", priority: 50 },
      middlewares: [{ type: 'health_check', config: { max_attempts: 3 } }],
      upstreams: [
        {
          kind: 'tcp',
          address: `127.0.0.1:${upstream.port}`,
          tls: false,
          sni: '',
          weight: 1,
        },
      ],
    })

    // before any traffic the upstream is not tracked yet
    const beforeStatus = routeById(server.status(), id)
    assert.ok(beforeStatus!.upstreams[0].health == null, 'health should be absent before traffic')

    const res = await proxyFetch(portA, '/status/hc')
    await res.text()
    assert.strictEqual(res.status, 200)

    // after traffic the passive health state is tracked
    const afterStatus = routeById(server.status(), id)
    const health = afterStatus!.upstreams[0].health
    assert.ok(health, 'health should be tracked after traffic')
    assert.strictEqual(health.healthy, true)
    assert.ok(health.tolerance >= 0)

    clean()
  })

  it('removed routes no longer appear in status', () => {
    const id = nextRouteId('status-gone')
    const clean = withRoute(server, {
      id,
      matcher: { rule: "PathPrefix('/status/gone')", priority: 50 },
      middlewares: [],
      upstreams: [
        {
          kind: 'tcp',
          address: `127.0.0.1:${upstream.port}`,
          tls: false,
          sni: '',
          weight: 1,
        },
      ],
    })

    assert.ok(routeById(server.status(), id))
    clean()
    assert.ok(!routeById(server.status(), id))
  })
})
