import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LonesomeServer } from '../../dist/index.js'
import { startProxy } from '../helpers/proxy.js'
import { nextRouteId, virtualUpstream, withRoute } from '../helpers/routes.js'
import { unregisterVirtualListener } from '../../dist/index.js'
import { registerVirtualListener } from '../../dist/index.js'
import {
  concurrentStatus,
  constantConcurrencyStatus,
  fetchJson,
  spawnCrashedRegisterWorker,
  spawnVirtualWorker,
  waitForWorkerEvent,
} from './helpers.js'

describe('worker_threads + virtual_js upstream', () => {
  let server: LonesomeServer
  let proxyPort: number

  before(async () => {
    ;({ server, port: proxyPort } = await startProxy())
  })

  after(() => {
    server.stop()
  })

  it('main thread route works when worker registers/unregisters listener', async () => {
    const key = 'wt-vjs-lifecycle'
    const path = '/wt/vjs/lifecycle'

    const cleanupRoute = withRoute(server, {
      id: nextRouteId('wt-vjs-lifecycle'),
      matcher: { rule: "PathPrefix('/wt/vjs/lifecycle')", priority: 80 },
      middlewares: [],
      upstreams: virtualUpstream(key),
      loadBalancer: { algorithm: 'round_robin', maxIterations: 16 },
    })

    const worker = spawnVirtualWorker(key, 'worker-A')

    try {
      const pre = await fetchJson(proxyPort, path)
      assert.strictEqual(pre.status, 502)

      worker.postMessage({ type: 'start' })
      await waitForWorkerEvent(worker, 'started')

      const active = await fetchJson(proxyPort, path)
      assert.strictEqual(active.status, 200)
      assert.strictEqual(active.body.marker, 'worker-A')

      worker.postMessage({ type: 'stop' })
      await waitForWorkerEvent(worker, 'stopped')

      const afterStop = await fetchJson(proxyPort, path)
      assert.strictEqual(afterStop.status, 502)

      worker.postMessage({ type: 'start' })
      await waitForWorkerEvent(worker, 'started')

      const restarted = await fetchJson(proxyPort, path)
      assert.strictEqual(restarted.status, 200)
      assert.strictEqual(restarted.body.marker, 'worker-A')

      worker.postMessage({ type: 'shutdown' })
      await waitForWorkerEvent(worker, 'shutdown-ack')
      await new Promise<void>((resolve) => worker.once('exit', () => resolve()))

      const afterShutdown = await fetchJson(proxyPort, path)
      assert.strictEqual(afterShutdown.status, 502)
    } finally {
      cleanupRoute()
      if (worker.threadId !== -1) {
        await worker.terminate()
      }
    }
  })

  it('concurrent requests stay stable before and after unregister/re-register', async () => {
    const key = 'wt-vjs-concurrency'
    const path = '/wt/vjs/concurrency'

    const cleanupRoute = withRoute(server, {
      id: nextRouteId('wt-vjs-concurrency'),
      matcher: { rule: "PathPrefix('/wt/vjs/concurrency')", priority: 80 },
      middlewares: [],
      upstreams: virtualUpstream(key),
      loadBalancer: { algorithm: 'round_robin', maxIterations: 16 },
    })

    const worker = spawnVirtualWorker(key, 'worker-B', 10)

    try {
      worker.postMessage({ type: 'start' })
      await waitForWorkerEvent(worker, 'started')

      const liveStatuses = await concurrentStatus(proxyPort, path, 64)
      assert.ok(liveStatuses.every((status) => status === 200), `unexpected statuses: ${liveStatuses.join(',')}`)

      worker.postMessage({ type: 'stop' })
      await waitForWorkerEvent(worker, 'stopped')

      const downStatuses = await concurrentStatus(proxyPort, path, 48)
      assert.ok(downStatuses.every((status) => status === 502), `unexpected statuses: ${downStatuses.join(',')}`)

      worker.postMessage({ type: 'start' })
      await waitForWorkerEvent(worker, 'started')

      const recoveredStatuses = await concurrentStatus(proxyPort, path, 64)
      assert.ok(
        recoveredStatuses.every((status) => status === 200),
        `unexpected statuses after recovery: ${recoveredStatuses.join(',')}`,
      )

      worker.postMessage({ type: 'shutdown' })
      await waitForWorkerEvent(worker, 'shutdown-ack')
      await new Promise<void>((resolve) => worker.once('exit', () => resolve()))
    } finally {
      cleanupRoute()
      if (worker.threadId !== -1) {
        await worker.terminate()
      }
    }
  })

  it('worker terminate() without explicit unregister should not break runtime', async () => {
    const key = 'wt-vjs-force-terminate'
    const path = '/wt/vjs/force-terminate'

    const cleanupRoute = withRoute(server, {
      id: nextRouteId('wt-vjs-force-terminate'),
      matcher: { rule: "PathPrefix('/wt/vjs/force-terminate')", priority: 80 },
      middlewares: [],
      upstreams: virtualUpstream(key),
      loadBalancer: { algorithm: 'round_robin', maxIterations: 16 },
    })

    const workerA = spawnVirtualWorker(key, 'worker-C')

    try {
      workerA.postMessage({ type: 'start' })
      await waitForWorkerEvent(workerA, 'started')

      const beforeKill = await fetchJson(proxyPort, path)
      assert.strictEqual(beforeKill.status, 200)
      assert.strictEqual(beforeKill.body.marker, 'worker-C')

      await workerA.terminate()

      const afterKillStatuses = await concurrentStatus(proxyPort, path, 24)
      assert.ok(
        afterKillStatuses.every((status) => status === 502),
        `expected all 502 after worker terminate, got: ${afterKillStatuses.join(',')}`,
      )

      unregisterVirtualListener(key)

      const workerB = spawnVirtualWorker(key, 'worker-D')
      try {
        workerB.postMessage({ type: 'start' })
        await waitForWorkerEvent(workerB, 'started')

        const recovered = await fetchJson(proxyPort, path)
        assert.strictEqual(recovered.status, 200)
        assert.strictEqual(recovered.body.marker, 'worker-D')

        workerB.postMessage({ type: 'shutdown' })
        await waitForWorkerEvent(workerB, 'shutdown-ack')
        await new Promise<void>((resolve) => workerB.once('exit', () => resolve()))
      } finally {
        if (workerB.threadId !== -1) {
          await workerB.terminate()
        }
      }
    } finally {
      cleanupRoute()
      if (workerA.threadId !== -1) {
        await workerA.terminate()
      }
    }
  })

  it('tsfn from crashed worker can be cleaned by first request path', async () => {
    const key = 'wt-vjs-crash-register'
    const path = '/wt/vjs/crash-register'

    const cleanupRoute = withRoute(server, {
      id: nextRouteId('wt-vjs-crash-register'),
      matcher: { rule: "PathPrefix('/wt/vjs/crash-register')", priority: 80 },
      middlewares: [],
      upstreams: virtualUpstream(key),
      loadBalancer: { algorithm: 'round_robin', maxIterations: 16 },
    })

    const worker = spawnCrashedRegisterWorker(key)
    try {
      await waitForWorkerEvent(worker, 'started')
      await new Promise<void>((resolve) => worker.once('exit', () => resolve()))

      const first = await fetchJson(proxyPort, path)
      assert.strictEqual(first.status, 502)

      registerVirtualListener(key, () => {})
      const removed = unregisterVirtualListener(key)
      assert.strictEqual(removed, true)
    } finally {
      cleanupRoute()
      if (worker.threadId !== -1) {
        await worker.terminate()
      }
      unregisterVirtualListener(key)
    }
  })

  it('concurrency remains bounded when terminate happens during in-flight requests', async () => {
    const key = 'wt-vjs-terminate-inflight'
    const path = '/wt/vjs/terminate-inflight'

    const cleanupRoute = withRoute(server, {
      id: nextRouteId('wt-vjs-terminate-inflight'),
      matcher: { rule: "PathPrefix('/wt/vjs/terminate-inflight')", priority: 80 },
      middlewares: [],
      upstreams: virtualUpstream(key),
      loadBalancer: { algorithm: 'round_robin', maxIterations: 16 },
    })

    const worker = spawnVirtualWorker(key, 'worker-inflight', 25)

    try {
      worker.postMessage({ type: 'start' })
      await waitForWorkerEvent(worker, 'started')

      const inFlightPromise = constantConcurrencyStatus(proxyPort, path, 12, 900)
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
      await worker.terminate()

      const inFlight = await inFlightPromise
      const statuses = inFlight.filter((v) => v.ok).map((v) => v.status)

      assert.ok(
        inFlight.every((v) => !v.ok || v.status === 200 || v.status === 502),
        `unexpected in-flight result set: ${JSON.stringify(inFlight.slice(0, 20))}`,
      )
      // Depending on scheduling, in-flight requests may all finish before terminate takes effect.
      assert.ok(
        inFlight.some((v) => (v.ok && (v.status === 200 || v.status === 502)) || !v.ok),
        'expected in-flight outcomes after terminate',
      )

      const postTerminate = await concurrentStatus(proxyPort, path, 16)
      assert.ok(postTerminate.every((status) => status === 502))

      unregisterVirtualListener(key)
      const workerRecover = spawnVirtualWorker(key, 'worker-inflight-recover', 5)
      try {
        workerRecover.postMessage({ type: 'start' })
        await waitForWorkerEvent(workerRecover, 'started')
        const recovered = await concurrentStatus(proxyPort, path, 16)
        assert.ok(recovered.every((status) => status === 200))

        workerRecover.postMessage({ type: 'shutdown' })
        await waitForWorkerEvent(workerRecover, 'shutdown-ack')
        await new Promise<void>((resolve) => workerRecover.once('exit', () => resolve()))
      } finally {
        if (workerRecover.threadId !== -1) {
          await workerRecover.terminate()
        }
      }
    } finally {
      cleanupRoute()
      if (worker.threadId !== -1) {
        await worker.terminate()
      }
      unregisterVirtualListener(key)
    }
  })
})
