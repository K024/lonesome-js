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
    assert.strictEqual(st.state, 'idle')
    assert.strictEqual(st.routeCount, 0)
    assert.strictEqual(st.threads, 0)
    assert.strictEqual(st.workStealing, false)
    assert.deepStrictEqual(st.listeners, [])
    assert.deepStrictEqual(st.routes, [])
  })

  it('reflects runtime config: running, threads, workStealing, listeners', () => {
    const st = server.status()
    assert.strictEqual(st.running, true)
    assert.strictEqual(st.state, 'running')
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

  it('reports state stopping during shutdown and stopped after', async () => {
    const s = new LonesomeServer()
    const p = await pickFreePort()
    s.start({ listeners: [{ kind: 'tcp', addr: `127.0.0.1:${p}` }] })
    await sleep(600)
    assert.strictEqual(s.status().state, 'running')

    const stopPromise = s.stop()
    // stop() is async: the JS thread stays free, so the stopping phase is
    // observable while the server drains.
    const deadline = Date.now() + 1500
    while (Date.now() < deadline && s.status().state !== 'stopping') {
      await sleep(10)
    }
    assert.strictEqual(s.status().state, 'stopping')

    await stopPromise
    assert.strictEqual(s.status().running, false)
    assert.strictEqual(s.status().state, 'stopped')
  })

  it('rejects a duplicate start while running', async () => {
    const s = new LonesomeServer()
    const p = await pickFreePort()
    s.start({ listeners: [{ kind: 'tcp', addr: `127.0.0.1:${p}` }] })
    await sleep(600)
    assert.throws(
      () => s.start({ listeners: [{ kind: 'tcp', addr: `127.0.0.1:${p}` }] }),
      /already started/,
    )
    await s.stop()
  })

  it('rejects start while stopping', async () => {
    const s = new LonesomeServer()
    const p = await pickFreePort()
    s.start({ listeners: [{ kind: 'tcp', addr: `127.0.0.1:${p}` }] })
    await sleep(600)

    const stopPromise = s.stop()
    // wait until the stopping phase is observable, then start must be rejected
    const deadline = Date.now() + 1500
    while (Date.now() < deadline && s.status().state !== 'stopping') {
      await sleep(10)
    }
    assert.strictEqual(s.status().state, 'stopping')
    assert.throws(
      () => s.start({ listeners: [{ kind: 'tcp', addr: `127.0.0.1:${p}` }] }),
      /stopping/,
    )
    await stopPromise
  })

  it('allows restart after a clean stop', async () => {
    const s = new LonesomeServer()
    const p = await pickFreePort()
    s.start({ listeners: [{ kind: 'tcp', addr: `127.0.0.1:${p}` }] })
    await sleep(600)
    await s.stop()
    assert.strictEqual(s.status().state, 'stopped')

    s.start({ listeners: [{ kind: 'tcp', addr: `127.0.0.1:${p}` }] })
    await sleep(600)
    assert.strictEqual(s.status().state, 'running')
    await s.stop()
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
