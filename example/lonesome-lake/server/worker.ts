/// <reference lib="webworker" />

/**
 * Function worker — runs inside a Deno worker with per-function permissions.
 * Loads the function handler via dynamic import (jsr/npm deps allowed), then
 * serves it over the runtime-assigned loopback port or Unix socket.
 *
 * Message protocol:
 *   parent -> worker:  { type: 'init', config: WorkerInit }
 *   parent -> worker:  { type: 'stop' }
 *   worker -> parent:  { type: 'ready', name }
 *   worker -> parent:  { type: 'error', reason: string }
 */

interface WorkerAddressLoopback {
  kind: 'loopback'
  hostname: string
  port: number
}

interface WorkerAddressUnix {
  kind: 'unix'
  path: string
}

type WorkerAddress = WorkerAddressLoopback | WorkerAddressUnix

interface WorkerInit {
  name: string
  handler: string
  address: WorkerAddress
  env?: Record<string, string>
  timeoutMs?: number
}

type RequestHandler = (req: Request) => Response | Promise<Response>

let controller: AbortController | null = null

forwardConsole()

self.onmessage = (event: MessageEvent) => {
  const msg = event.data
  if (msg?.type === 'init') {
    void boot(msg.config as WorkerInit)
  } else if (msg?.type === 'stop') {
    shutdown()
  }
}

function forwardConsole(): void {
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      try {
        self.postMessage({
          type: 'log',
          level,
          message: args.map(String).join(' '),
        })
      } catch {
        // parent gone
      }
    }
  }
}

async function boot(config: WorkerInit): Promise<void> {
  try {
    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        Deno.env.set(key, value)
      }
    }

    let handler: RequestHandler
    try {
      const mod = await import(config.handler)
      handler = mod.default as RequestHandler
      if (typeof handler !== 'function') {
        throw new Error(
          `default export of "${config.handler}" is not a function`,
        )
      }
    } catch (err) {
      throw new Error(`failed to load handler "${config.handler}": ${err}`)
    }

    if (config.timeoutMs) handler = withTimeout(handler, config.timeoutMs)

    controller = new AbortController()
    serve(config.name, config.address, handler)
  } catch (err) {
    self.postMessage({ type: 'error', reason: String(err) })
  }
}

function serve(
  name: string,
  address: WorkerAddress,
  handler: RequestHandler,
): void {
  if (address.kind === 'unix') {
    Deno.serve(
      {
        transport: 'unix',
        path: address.path,
        signal: controller?.signal,
        onListen() {
          console.log(`[${name}] listening on unix:${address.path}`)
          self.postMessage({ type: 'ready', name })
        },
      },
      handler,
    )
  } else {
    Deno.serve(
      {
        port: address.port,
        hostname: address.hostname,
        signal: controller?.signal,
        onListen() {
          console.log(
            `[${name}] listening on ${address.hostname}:${address.port}`,
          )
          self.postMessage({ type: 'ready', name })
        },
      },
      handler,
    )
  }
}

function withTimeout(
  handler: RequestHandler,
  timeoutMs: number,
): RequestHandler {
  return (req: Request) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      Promise.resolve(handler(req)).then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (err: unknown) => {
          clearTimeout(timer)
          reject(err instanceof Error ? err : new Error(String(err)))
        },
      )
    })
}

function shutdown(): void {
  controller?.abort()
  controller = null
  self.close()
}
