import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { LonesomeServer } from '../../dist/index.js'
import {
  registerVirtualInterceptor,
  unregisterVirtualInterceptor,
  unregisterVirtualListener,
} from '../../dist/index.js'
import { startProxy } from '../helpers/proxy.js'
import { nextRouteId, virtualUpstream, withRoute } from '../helpers/routes.js'
import {
  concurrentStatus,
  fetchJson,
  spawnVirtualWorker,
  waitForWorkerEvent,
} from './helpers.js'

describe('worker_threads + virtual_js interceptor', () => {
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
      middlewares: [],
      upstreams: virtualUpstream(key),
      loadBalancer: { algorithm: 'round_robin', maxIterations: 16 },
    })

    let interceptCount = 0
    let workerStarted = false
    const workerRef: { current: ReturnType<typeof spawnVirtualWorker> | null } = { current: null }
    registerVirtualInterceptor(key, async () => {
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
    })

    try {
      const first = await fetchJson(proxyPort, path)
      assert.strictEqual(first.status, 200)
      assert.strictEqual(first.body.marker, 'worker-interceptor')
      assert.strictEqual(interceptCount, 1)

      const removed = unregisterVirtualInterceptor(key)
      assert.strictEqual(removed, true)

      const statuses = await concurrentStatus(proxyPort, path, 24)
      assert.ok(statuses.every((status) => status === 200), `unexpected statuses: ${statuses.join(',')}`)
      assert.strictEqual(interceptCount, 1)
    } finally {
      cleanupRoute()
      unregisterVirtualInterceptor(key)
      unregisterVirtualListener(key)
      const worker = workerRef.current
      if (worker && worker.threadId !== -1) {
        try {
          worker.postMessage({ type: 'shutdown' })
          await waitForWorkerEvent(worker, 'shutdown-ack')
          await once(worker, 'exit')
        } catch {
          await worker.terminate()
        }
      }
    }
  })

  it('rejected interceptor promise fails connect with 502 and can be recovered by unregister', async () => {
    const key = 'wt-vjs-interceptor-reject'
    const path = '/wt/vjs/interceptor-reject'

    const cleanupRoute = withRoute(server, {
      id: nextRouteId('wt-vjs-interceptor-reject'),
      matcher: { rule: "PathPrefix('/wt/vjs/interceptor-reject')", priority: 80 },
      middlewares: [],
      upstreams: virtualUpstream(key),
      loadBalancer: { algorithm: 'round_robin', maxIterations: 16 },
    })

    const worker = spawnVirtualWorker(key, 'worker-recover')

    try {
      worker.postMessage({ type: 'start' })
      await waitForWorkerEvent(worker, 'started')

      registerVirtualInterceptor(key, async () => {
        throw new Error('reject in interceptor')
      })

      const failed = await fetchJson(proxyPort, path)
      assert.strictEqual(failed.status, 502)

      const removed = unregisterVirtualInterceptor(key)
      assert.strictEqual(removed, true)

      const recovered = await fetchJson(proxyPort, path)
      assert.strictEqual(recovered.status, 200)
      assert.strictEqual(recovered.body.marker, 'worker-recover')

      worker.postMessage({ type: 'shutdown' })
      await waitForWorkerEvent(worker, 'shutdown-ack')
      await once(worker, 'exit')
    } finally {
      cleanupRoute()
      unregisterVirtualInterceptor(key)
      unregisterVirtualListener(key)
      if (worker.threadId !== -1) {
        await worker.terminate()
      }
    }
  })

  it('duplicate interceptor register is rejected and unregister is idempotent', () => {
    const key = 'wt-vjs-interceptor-duplicate'

    try {
      registerVirtualInterceptor(key, async () => {})

      assert.throws(
        () => registerVirtualInterceptor(key, async () => {}),
        /already exists/,
      )

      assert.strictEqual(unregisterVirtualInterceptor(key), true)
      assert.strictEqual(unregisterVirtualInterceptor(key), false)
    } finally {
      unregisterVirtualInterceptor(key)
      unregisterVirtualListener(key)
    }
  })
})
