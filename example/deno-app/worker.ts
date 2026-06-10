/// <reference lib="webworker" />

/**
 * Worker entry — pure Deno, no napi-rs dependency.
 *
 * 1. Dynamically imports the `main` script specified in config
 * 2. Uses its default export as the request handler for Deno.serve()
 * 3. Starts listening on the runtime-assigned loopback port or Unix socket
 *
 * Protocol (postMessage):
 *   parent → worker:  { type: 'init', config: WorkerDef }
 *   parent → worker:  { type: 'stop' }
 *   worker → parent:  { type: 'ready' }
 *   worker → parent:  { type: 'error', reason: string }
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
  main: string
  address: WorkerAddress
  env?: Record<string, string>
  matcher: { rule: string; priority?: number }
}

type RequestHandler = (req: Request) => Response | Promise<Response>

let controller: AbortController | null = null

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data
  if (msg?.type === 'init') {
    await boot(msg.config as WorkerInit)
  } else if (msg?.type === 'stop') {
    shutdown()
  }
}

async function boot(config: WorkerInit): Promise<void> {
  try {
    if (config.env) {
      for (const [k, v] of Object.entries(config.env)) {
        Deno.env.set(k, v)
      }
    }

    let handler: RequestHandler
    try {
      const mod = await import(config.main)
      handler = mod.default as RequestHandler
      if (typeof handler !== 'function') {
        throw new Error(`default export of "${config.main}" is not a function`)
      }
    } catch (err) {
      throw new Error(`failed to load handler "${config.main}": ${err}`)
    }

    controller = new AbortController()

    if (config.address.kind === 'unix') {
      serveUnix(config.name, config.address, handler)
    } else {
      serveLoopback(config.name, config.address, handler)
    }
  } catch (err) {
    self.postMessage({ type: 'error', reason: String(err) })
  }
}

function serveLoopback(
  name: string,
  address: WorkerAddressLoopback,
  handler: RequestHandler,
): void {
  Deno.serve(
    {
      port: address.port,
      hostname: address.hostname,
      signal: controller?.signal,
      onListen({ hostname, port }) {
        console.log(`[${name}] listening on ${hostname}:${port}`)
        self.postMessage({ type: 'ready', name })
      },
    },
    handler,
  )
}

function serveUnix(
  name: string,
  address: WorkerAddressUnix,
  handler: RequestHandler,
): void {
  Deno.serve(
    {
      transport: 'unix',
      path: address.path,
      signal: controller?.signal,
      onListen({ path }) {
        console.log(`[${name}] listening on unix:${path}`)
        self.postMessage({ type: 'ready', name })
      },
    },
    handler,
  )
}

function shutdown(): void {
  controller?.abort()
  controller = null
  self.close()
}
