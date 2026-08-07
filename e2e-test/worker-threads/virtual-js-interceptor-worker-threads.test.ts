import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { proxyFetch } from '../helpers/request.js'
import type { LonesomeServer } from '../../dist/index.js'
import {
  registerInterceptor,
  unregisterInterceptor,
  unregisterVirtualListener,
} from '../../dist/index.js'
import { startProxy } from '../helpers/proxy.js'
import { nextRouteId, virtualUpstream, withRoute } from '../helpers/routes.js'
import {
  concurrentStatus,
  fetchJson,
  shutdownWorker,
  spawnVirtualWorker,
  waitForWorkerEvent,
} from './helpers.js'

describe('worker_threads + interceptor middleware', () => {
  let server: LonesomeServer
  let proxyPort: number

  before(async () => {
    ;({ server, port: proxyPort } = await startProxy())
  })

  after(() => {
    server.stop()
  })

  it('interceptor can gate first connect until worker listener is ready, then no re-trigger after unregister', async () => {
    const key = 'wt-vjs-interceptor-gate'
    const path = '/wt/vjs/interceptor-gate'

    const cleanupRoute = withRoute(server, {
      id: nextRouteId('wt-vjs-interceptor-gate'),
      matcher: { rule: "PathPrefix('/wt/vjs/interceptor-gate')", priority: 80 },
      middlewares: [{ type: 'interceptor', config: { key } }],
      upstreams: virtualUpstream(key),
      loadBalancer: { algorithm: 'round_robin', maxIterations: 16 },
    })

    let interceptCount = 0
    let workerStarted = false
    const workerRef: { current: ReturnType<typeof spawnVirtualWorker> | null } = { current: null }
    registerInterceptor(key, async () => {
      interceptCount += 1
      if (workerStarted) {
        throw new Error('interceptor should not be triggered after unregister')
      }

      workerRef.current = spawnVirtualWorker(key, 'worker-interceptor')
      try {
        workerRef.current.postMessage({ type: 'start' })
        await waitForWorkerEvent(workerRef.current, 'started')
        workerStarted = true
      } catch (err) {
        await workerRef.current.terminate()
        workerRef.current = null
        throw err
      }

      return { action: 'continue' }
    })

    try {
      const first = await fetchJson(proxyPort, path)
      assert.strictEqual(first.status, 200)
      assert.strictEqual(first.body.marker, 'worker-interceptor')
      assert.strictEqual(interceptCount, 1)

      const removed = unregisterInterceptor(key)
      assert.strictEqual(removed, true)

      const statuses = await concurrentStatus(proxyPort, path, 24)
      assert.ok(statuses.every((status) => status === 200), `unexpected statuses: ${statuses.join(',')}`)
      assert.strictEqual(interceptCount, 1)
    } finally {
      cleanupRoute()
      unregisterInterceptor(key)
      unregisterVirtualListener(key)
      const worker = workerRef.current
      if (worker && worker.threadId !== -1) {
        try {
          await shutdownWorker(worker)
        } catch {
          await worker.terminate()
        }
      }
    }
  })

  it('interceptor can short-circuit and can be recovered by unregister', async () => {
    const key = 'wt-vjs-interceptor-reject'
    const path = '/wt/vjs/interceptor-reject'

    const cleanupRoute = withRoute(server, {
      id: nextRouteId('wt-vjs-interceptor-reject'),
      matcher: { rule: "PathPrefix('/wt/vjs/interceptor-reject')", priority: 80 },
      middlewares: [{ type: 'interceptor', config: { key } }],
      upstreams: virtualUpstream(key),
      loadBalancer: { algorithm: 'round_robin', maxIterations: 16 },
    })

    const worker = spawnVirtualWorker(key, 'worker-recover')

    try {
      worker.postMessage({ type: 'start' })
      await waitForWorkerEvent(worker, 'started')

      registerInterceptor(key, async () => {
        return { action: 'respond', status: 503, body: 'blocked by interceptor' }
      })

      const failed = await fetchJson(proxyPort, path)
      assert.strictEqual(failed.status, 503)

      const removed = unregisterInterceptor(key)
      assert.strictEqual(removed, true)

      const recovered = await fetchJson(proxyPort, path)
      assert.strictEqual(recovered.status, 200)
      assert.strictEqual(recovered.body.marker, 'worker-recover')

      await shutdownWorker(worker)
    } finally {
      cleanupRoute()
      unregisterInterceptor(key)
      unregisterVirtualListener(key)
      if (worker.threadId !== -1) {
        await worker.terminate()
      }
    }
  })


  it('interceptor receives request fields and can respond with body/content-type', async () => {
    const key = 'interceptor-request-fields'
    const path = '/interceptor/request-fields?x=1'
    const seen: Array<{ key: string; method: string; path: string }> = []

    const cleanupRoute = withRoute(server, {
      id: nextRouteId('interceptor-request-fields'),
      matcher: { rule: "PathPrefix('/interceptor/request-fields')", priority: 80 },
      middlewares: [{ type: 'interceptor', config: { key } }],
      upstreams: virtualUpstream('missing-listener-should-not-be-used'),
      loadBalancer: { algorithm: 'round_robin', maxIterations: 16 },
    })

    registerInterceptor(key, async (request) => {
      seen.push(request)
      return {
        action: 'respond',
        status: 418,
        body: JSON.stringify({ ok: true, method: request.method, path: request.path }),
        contentType: 'application/json',
      }
    })

    try {
      const res = await proxyFetch(proxyPort, path, {
        method: 'POST',
        signal: AbortSignal.timeout(3000),
      })
      assert.strictEqual(res.status, 418)
      assert.strictEqual(res.headers.get('content-type'), 'application/json')
      const body = await res.json()
      assert.deepStrictEqual(body, { ok: true, method: 'POST', path })

      assert.strictEqual(seen.length, 1)
      assert.strictEqual(seen[0].key, key)
      assert.strictEqual(seen[0].method, 'POST')
      assert.strictEqual(seen[0].path, path)
    } finally {
      cleanupRoute()
      unregisterInterceptor(key)
    }
  })

  it('interceptor middleware continues by default when js handler is missing', async () => {
    const key = 'interceptor-missing-handler'
    const path = '/interceptor/missing-handler'
    const worker = spawnVirtualWorker(key, 'missing-handler-continue')

    const cleanupRoute = withRoute(server, {
      id: nextRouteId('interceptor-missing-handler'),
      matcher: { rule: "PathPrefix('/interceptor/missing-handler')", priority: 80 },
      middlewares: [{ type: 'interceptor', config: { key } }],
      upstreams: virtualUpstream(key),
      loadBalancer: { algorithm: 'round_robin', maxIterations: 16 },
    })

    try {
      worker.postMessage({ type: 'start' })
      await waitForWorkerEvent(worker, 'started')

      const res = await fetchJson(proxyPort, path)
      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.body.marker, 'missing-handler-continue')
    } finally {
      cleanupRoute()
      unregisterInterceptor(key)
      unregisterVirtualListener(key)
      if (worker.threadId !== -1) {
        try {
          await shutdownWorker(worker)
        } catch {
          await worker.terminate()
        }
      }
    }
  })

  it('duplicate interceptor register is rejected and unregister is idempotent', () => {
    const key = 'wt-vjs-interceptor-duplicate'

    try {
      registerInterceptor(key, async () => {})

      assert.throws(
        () => registerInterceptor(key, async () => {}),
        /already exists/,
      )

      assert.strictEqual(unregisterInterceptor(key), true)
      assert.strictEqual(unregisterInterceptor(key), false)
    } finally {
      unregisterInterceptor(key)
      unregisterVirtualListener(key)
    }
  })
})
