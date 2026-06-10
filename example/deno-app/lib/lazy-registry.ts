import type { AppEvent } from './types.ts'

/**
 * Registry for lazy worker activation promises.
 * Interceptor callbacks await these; the reducer resolves them on WorkerReady.
 */
type Activation = {
  promise: Promise<void>
  resolve: () => void
  reject: (err: Error) => void
}

const activations = new Map<string, Activation>()

export function ensureWorkerActive(
  name: string,
  dispatch: (event: AppEvent) => void,
): Promise<void> {
  const existing = activations.get(name)
  if (existing) return existing.promise

  let resolve!: () => void
  let reject!: (err: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })

  activations.set(name, { promise, resolve, reject })
  dispatch({ type: 'LazyWorkerRequested', name })
  return promise
}

export function markWorkerReady(name: string): void {
  const entry = activations.get(name)
  if (entry) {
    entry.resolve()
    activations.delete(name)
  }
}

export function markWorkerFailed(name: string, err: Error): void {
  const entry = activations.get(name)
  if (entry) {
    entry.reject(err)
    activations.delete(name)
  }
}
