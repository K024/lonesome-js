import type { AppState, AppEvent, AppEffect, WorkerDef } from './types.ts';
import { ensureWorkerActive } from './lazy-registry.ts';

let serverModule: { LonesomeServer: new () => any } | null = null;

async function getServer(): Promise<{ LonesomeServer: new () => any } | null> {
  if (serverModule) return serverModule;
  try {
    serverModule = await import('../../../dist/index.js');
    return serverModule;
  } catch (err) {
    log('error', `failed to load lonesome-js: ${err}`);
    return null;
  }
}

async function getInterceptorApi() {
  const mod = await import('../../../dist/index.js');
  return {
    registerInterceptor: (mod as any).registerInterceptor as
      (key: string, fn: (req: { key: string; requestId: string; method: string; path: string }) => Promise<any>) => void,
    unregisterInterceptor: (mod as any).unregisterInterceptor as (key: string) => boolean,
  };
}

export async function runEffect(
  effect: AppEffect,
  dispatch: (event: AppEvent) => void,
  state: AppState,
): Promise<void> {
  switch (effect.type) {
    case 'LoadConfig': {
      try {
        const raw = await Deno.readTextFile(effect.path);
        dispatch({ type: 'ConfigLoaded', config: JSON.parse(raw) });
      } catch (err) {
        dispatch({ type: 'ConfigError', error: String(err) });
      }
      break;
    }

    case 'WatchConfig': {
      const watcher = Deno.watchFs(effect.path);
      state.watcher = watcher;
      (async () => {
        for await (const ev of watcher) {
          if (ev.kind === 'modify' || ev.kind === 'create') {
            try {
              const raw = await Deno.readTextFile(effect.path);
              dispatch({ type: 'ConfigChanged', config: JSON.parse(raw) });
            } catch (err) {
              dispatch({ type: 'ConfigError', error: `hot-reload: ${err}` });
            }
          }
        }
      })();
      break;
    }

    case 'StartServer': {
      const mod = await getServer();
      if (!mod) return dispatch({ type: 'ConfigError', error: 'cannot load LonesomeServer' });
      try {
        const server = new mod.LonesomeServer();
        server.start({
          threads: effect.config.threads ?? 0,
          workStealing: effect.config.workStealing ?? false,
          listeners: effect.config.listeners,
        });
        state.server = server;
        log('info', `server started on ${effect.config.listeners.map((l) => l.addr).join(', ')}`);
      } catch (err) {
        dispatch({ type: 'ConfigError', error: `server start failed: ${err}` });
      }
      break;
    }

    case 'StopServer': {
      if (state.server) {
        try { (state.server as any).stop(); } catch { /* Windows no-op */ }
        state.server = null;
        log('info', 'server stopped');
      }
      break;
    }

    // ── Lazy interceptor registration ──────────────
    case 'AddLazyRoute': {
      if (!state.server) return;
      const w = effect.def;
      const routeId = `wrk-${w.name}`;
      const interceptorKey = `lazy-${w.name}`;

      try {
        const api = await getInterceptorApi();

        // Register the interceptor — awaits worker readiness, then continues.
        api.registerInterceptor(interceptorKey, async (_req) => {
          if (!state.readyWorkers.has(w.name)) {
            try {
              await ensureWorkerActive(w.name, dispatch);
            } catch (err) {
              return {
                action: 'respond',
                status: 503,
                body: `worker ${w.name} unavailable: ${err}`,
                contentType: 'text/plain',
              };
            }
          }
          return { action: 'continue' };
        });

        // Register the route with interceptor middleware
        (state.server as any).addOrUpdate({
          id: routeId,
          matcher: w.matcher,
          middlewares: [
            { type: 'interceptor', config: { key: interceptorKey } },
            ...(w.middlewares ?? []),
          ],
          upstreams: [{
            kind: 'tcp',
            address: `127.0.0.1:${w.port}`,
            tls: false, sni: '', weight: 1,
          }],
        });

        state.workerRoutes.set(w.name, routeId);
        log('info', `lazy route registered: ${routeId} (interceptor: ${interceptorKey})`);
      } catch (err) {
        log('error', `lazy route failed (${routeId}): ${err}`);
      }
      break;
    }

    case 'SpawnWorker': {
      const def = effect.def;
      const appRoot = new URL('..', import.meta.url).href;
      // Worker entry is always worker.ts (the generic Deno worker wrapper).
      // def.main is the handler script — passed to the worker via postMessage.
      const workerUrl = new URL('./worker.ts', appRoot).href;

      const worker = new Worker(workerUrl, { type: 'module', name: def.name });

      worker.onmessage = (e: MessageEvent) => {
        const msg = e.data;
        if (msg?.type === 'ready') {
          dispatch({ type: 'WorkerReady', name: def.name });
        } else if (msg?.type === 'error') {
          dispatch({ type: 'WorkerCrashed', name: def.name, reason: msg.reason ?? 'unknown' });
        }
      };

      worker.onerror = (err: ErrorEvent) => {
        dispatch({ type: 'WorkerCrashed', name: def.name, reason: err.message });
      };

      worker.postMessage({ type: 'init', config: def });
      state.workers.set(def.name, { worker, config: def });
      log('info', `worker spawned: ${def.name}`);
      break;
    }

    case 'KillWorker': {
      const handle = state.workers.get(effect.name);
      if (handle) {
        try { handle.worker.postMessage({ type: 'stop' }); } catch { /* ok */ }
        handle.worker.terminate();
        state.workers.delete(effect.name);
        log('info', `worker stopped: ${effect.name}`);
      }
      break;
    }

    case 'AddRoute':
    case 'UpdateRoute': {
      if (!state.server) return;
      const w = effect.def;
      const routeId = `wrk-${w.name}`;
      try {
        (state.server as any).addOrUpdate({
          id: routeId,
          matcher: w.matcher,
          middlewares: w.middlewares ?? [],
          upstreams: [{
            kind: 'tcp',
            address: `127.0.0.1:${w.port}`,
            tls: false, sni: '', weight: 1,
          }],
        });
        log('info', `route ${effect.type === 'UpdateRoute' ? 'updated' : 'added'}: ${routeId} → 127.0.0.1:${w.port}`);
      } catch (err) {
        log('error', `route failed (${routeId}): ${err}`);
      }
      break;
    }

    case 'RemoveRoute': {
      if (!state.server) return;
      try { (state.server as any).remove(effect.routeId); } catch { /* ok */ }
      log('info', `route removed: ${effect.routeId}`);
      break;
    }

    case 'UnregisterInterceptor': {
      try {
        const api = await getInterceptorApi();
        api.unregisterInterceptor(effect.key);
        log('info', `interceptor unregistered: ${effect.key}`);
      } catch (err) {
        log('error', `unregister interceptor failed (${effect.key}): ${err}`);
      }
      break;
    }

    case 'Log': {
      log(effect.level, effect.message);
      break;
    }
  }
}

function log(level: string, message: string): void {
  const ts = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  console.log(`${ts}  ${tag}  ${message}`);
}
