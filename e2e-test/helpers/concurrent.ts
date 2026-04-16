export function createTaskQueue(max = 10) {
  let current = 0
  const queue: (() => Promise<void>)[] = []

  const next = () => {
    if (queue.length === 0 || current >= max) return
    current++, queue.shift()!().then(() => current--).then(next)
  }

  return function enqueue<T>(fn: () => Promise<T>) {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => Promise.resolve().then(fn).then(resolve, reject)), next()
    })
  }
}

export type ConcurrencyOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown }

export async function runConstantConcurrency<T>(opts: {
  concurrency: number
  durationMs: number
  task: () => Promise<T>
}): Promise<ConcurrencyOutcome<T>[]> {
  const { concurrency, durationMs, task } = opts
  if (concurrency <= 0) {
    throw new Error(`concurrency must be > 0, got ${concurrency}`)
  }
  if (durationMs <= 0) {
    throw new Error(`durationMs must be > 0, got ${durationMs}`)
  }

  const deadline = Date.now() + durationMs
  const results: ConcurrencyOutcome<T>[] = []

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (Date.now() < deadline) {
        try {
          results.push({ ok: true, value: await task() })
        } catch (error) {
          results.push({ ok: false, error })
        }
      }
    }),
  )

  return results
}
