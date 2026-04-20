import { Worker } from 'node:worker_threads'
import { proxyFetch } from '../helpers/request.js'
import { runConstantConcurrency } from '../helpers/concurrent.js'

export type WorkerEvent =
  | { type: 'started'; key: string }
  | { type: 'stopped'; key: string }
  | { type: 'shutdown-ack'; key: string }
  | { type: 'worker-error'; key: string; message: string }

const WAIT_TIMEOUT_MS = 5000

export function waitForWorkerEvent(worker: Worker, expectedType: WorkerEvent['type']): Promise<WorkerEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timeout waiting for worker event: ${expectedType}`))
    }, WAIT_TIMEOUT_MS)

    function cleanup() {
      clearTimeout(timer)
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
    }

    function onMessage(msg: WorkerEvent) {
      if (msg.type === 'worker-error') {
        cleanup()
        reject(new Error(`worker reported error: ${msg.message}`))
        return
      }

      if (msg.type === expectedType) {
        cleanup()
        resolve(msg)
      }
    }

    function onError(err: Error) {
      cleanup()
      reject(err)
    }

    function onExit(code: number) {
      cleanup()
      reject(new Error(`worker exited before ${expectedType}, code=${code}`))
    }

    worker.on('message', onMessage)
    worker.on('error', onError)
    worker.on('exit', onExit)
  })
}

export function spawnVirtualWorker(key: string, marker: string, delayMs = 0): Worker {
  return new Worker(new URL('./virtual-worker.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'],
    workerData: { key, marker, delayMs },
  })
}

export function spawnCrashedRegisterWorker(key: string): Worker {
  return new Worker(new URL('./virtual-worker-crash-register.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'],
    workerData: { key },
  })
}

export async function fetchJson(port: number, path: string): Promise<{ status: number; body: any }> {
  const res = await proxyFetch(port, path, { signal: AbortSignal.timeout(3000) })
  const text = await res.text()
  let body: any = text
  try {
    body = JSON.parse(text)
  } catch {
    // keep raw text
  }
  return { status: res.status, body }
}

export async function concurrentStatus(port: number, path: string, count: number): Promise<number[]> {
  const tasks = Array.from({ length: count }, () => proxyFetch(port, path, { signal: AbortSignal.timeout(3000) }))
  const responses = await Promise.all(tasks)
  await Promise.all(responses.map((res) => res.text()))
  return responses.map((res) => res.status)
}

export async function constantConcurrencyStatus(
  port: number,
  path: string,
  concurrency: number,
  durationMs: number,
): Promise<Array<{ ok: true; status: number } | { ok: false; message: string }>> {
  const outcomes = await runConstantConcurrency({
    concurrency,
    durationMs,
    task: async () => {
      const res = await proxyFetch(port, path, { signal: AbortSignal.timeout(3000) })
      await res.text()
      return res.status
    },
  })

  return outcomes.map((outcome) => {
    if (outcome.ok) {
      return { ok: true as const, status: outcome.value }
    }

    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
    return { ok: false as const, message }
  })
}
