import type { AppState, AppEvent, AppEffect, WorkerDef } from './types.ts';
import { markWorkerReady, markWorkerFailed } from './lazy-registry.ts';

export function reduce(state: AppState, event: AppEvent): [AppState, AppEffect[]] {
  switch (event.type) {
    case 'Init':
      return [state, [
        { type: 'LoadConfig', path: event.configPath },
        { type: 'WatchConfig', path: event.configPath },
        { type: 'Log', level: 'info', message: 'lonesome-deno started' },
      ]];

    case 'ConfigLoaded': {
      const effects: AppEffect[] = [];
      if (event.config.listeners.length > 0) {
        effects.push({ type: 'StartServer', config: event.config });
      }
      for (const w of event.config.workers) {
        if (w.lazy) {
          // Register route immediately with interceptor middleware
          effects.push({ type: 'AddLazyRoute', def: w });
        } else {
          effects.push({ type: 'SpawnWorker', def: w });
        }
      }
      effects.push({ type: 'Log', level: 'info', message: `config loaded: ${event.config.workers.length} worker(s)` });
      return [{
        config: event.config,
        server: state.server,
        workers: new Map(),
        readyWorkers: new Set(),
        workerRoutes: new Map(),
        watcher: state.watcher,
      }, effects];
    }

    case 'ConfigError':
      return [state, [{ type: 'Log', level: 'error', message: `config error: ${event.error}` }]];

    case 'ConfigChanged': {
      const prev = state.config;
      if (!prev) return [state, []];
      const effects: AppEffect[] = [
        { type: 'Log', level: 'info', message: 'config changed, reconciling...' },
      ];

      if (JSON.stringify(prev.listeners) !== JSON.stringify(event.config.listeners)) {
        effects.push({ type: 'StopServer' });
        if (event.config.listeners.length > 0) effects.push({ type: 'StartServer', config: event.config });
      }

      const prevNames = new Set(prev.workers.map((w) => w.name));
      const nextNames = new Set(event.config.workers.map((w) => w.name));
      for (const name of prevNames) {
        if (!nextNames.has(name)) effects.push({ type: 'KillWorker', name });
      }
      for (const nextW of event.config.workers) {
        if (!prevNames.has(nextW.name)) {
          if (nextW.lazy) effects.push({ type: 'AddLazyRoute', def: nextW });
          else effects.push({ type: 'SpawnWorker', def: nextW });
        } else {
          const prevW = prev.workers.find((w) => w.name === nextW.name)!;
          if (!deepEqual(prevW, nextW)) {
            effects.push({ type: 'KillWorker', name: nextW.name });
            if (nextW.lazy) effects.push({ type: 'AddLazyRoute', def: nextW });
            else effects.push({ type: 'SpawnWorker', def: nextW });
          }
        }
      }
      return [{ ...state, config: event.config }, effects];
    }

    case 'LazyWorkerRequested': {
      const worker = state.config?.workers.find((w) => w.name === event.name);
      if (!worker) return [state, []];
      return [state, [
        { type: 'Log', level: 'info', message: `lazy worker activating: ${event.name}` },
        { type: 'SpawnWorker', def: worker },
      ]];
    }

    case 'WorkerReady': {
      const worker = state.config?.workers.find((w) => w.name === event.name);
      if (!worker) return [state, []];
      const routeId = `wrk-${worker.name}`;
      const routes = new Map(state.workerRoutes);
      routes.set(worker.name, routeId);

      // Release the lazy interceptor
      markWorkerReady(event.name);

      const ready = new Set(state.readyWorkers);
      ready.add(event.name);

      return [{ ...state, readyWorkers: ready, workerRoutes: routes }, [
        { type: 'Log', level: 'info', message: `worker ready: ${event.name}` },
        ...(worker.lazy
          ? [
              { type: 'UpdateRoute' as const, def: worker },
              { type: 'UnregisterInterceptor' as const, key: `lazy-${event.name}` },
            ]
          : [{ type: 'AddRoute' as const, def: worker }]),
      ]];
    }

    case 'WorkerCrashed': {
      markWorkerFailed(event.name, new Error(event.reason));
      const next = new Map(state.workers);
      next.delete(event.name);
      const routes = new Map(state.workerRoutes);
      const routeId = routes.get(event.name);
      const effects: AppEffect[] = [
        { type: 'Log', level: 'error', message: `worker crashed: ${event.name} — ${event.reason}` },
      ];
      if (routeId) { effects.push({ type: 'RemoveRoute', routeId }); routes.delete(event.name); }
      const ready = new Set(state.readyWorkers);
      ready.delete(event.name);
      return [{ ...state, readyWorkers: ready, workers: next, workerRoutes: routes }, effects];
    }

    case 'Shutdown': {
      const effects: AppEffect[] = [
        { type: 'Log', level: 'info', message: 'shutting down...' },
        { type: 'StopServer' },
      ];
      for (const [name] of state.workers) effects.push({ type: 'KillWorker', name });
      return [state, effects];
    }

    default:
      return [state, []];
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
