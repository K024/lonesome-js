/// <reference lib="webworker" />

/**
 * Worker entry — pure Deno, no napi-rs dependency.
 *
 * 1. Dynamically imports the `main` script specified in config
 * 2. Uses its default export as the request handler for Deno.serve()
 * 3. Starts listening on the assigned port with restricted permissions
 *
 * Protocol (postMessage):
 *   parent → worker:  { type: 'init', config: WorkerDef }
 *   parent → worker:  { type: 'stop' }
 *   worker → parent:  { type: 'ready' }
 *   worker → parent:  { type: 'error', reason: string }
 */

interface WorkerInit {
  name: string;
  main: string;
  port: number;
  env?: Record<string, string>;
  matcher: { rule: string; priority?: number };
}

type RequestHandler = (req: Request) => Response | Promise<Response>;

let controller: AbortController | null = null;

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg?.type === 'init') {
    await boot(msg.config as WorkerInit);
  } else if (msg?.type === 'stop') {
    shutdown();
  }
};

async function boot(config: WorkerInit): Promise<void> {
  try {
    if (config.env) {
      for (const [k, v] of Object.entries(config.env)) {
        Deno.env.set(k, v);
      }
    }

    let handler: RequestHandler;
    try {
      const mod = await import(config.main);
      handler = mod.default as RequestHandler;
      if (typeof handler !== 'function') {
        throw new Error(`default export of "${config.main}" is not a function`);
      }
    } catch (err) {
      throw new Error(`failed to load handler "${config.main}": ${err}`);
    }

    controller = new AbortController();

    Deno.serve(
      {
        port: config.port,
        hostname: '127.0.0.1',
        signal: controller.signal,
        onListen({ hostname, port }) {
          console.log(`[${config.name}] listening on ${hostname}:${port}`);
          self.postMessage({ type: 'ready', name: config.name });
        },
      },
      handler,
    );

    console.log(`[${config.name}] server stopped`);
  } catch (err) {
    self.postMessage({ type: 'error', reason: String(err) });
  }
}

function shutdown(): void {
  controller?.abort();
  controller = null;
  self.close();
}
