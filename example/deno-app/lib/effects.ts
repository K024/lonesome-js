import {
  LonesomeServer,
  registerInterceptor,
  unregisterInterceptor,
} from 'npm:lonesome-js@0.1.x'
import type { AppEffect, AppEvent, AppState, WorkerDef } from './types.ts'
import { ensureWorkerActive } from './lazy-registry.ts'
import { materializeConfig } from './runtime-config.ts'
import {
  formatAddress,
  instanceKey,
  lazyInterceptorKeyFor,
  requireAddresses,
  routeIdFor,
  upstreamsFor,
} from './worker-route.ts'

export async function runEffect(
  effect: AppEffect,
  dispatch: (event: AppEvent) => void,
  state: AppState,
): Promise<void> {
  switch (effect.type) {
    case 'LoadConfig':
      await loadConfig(effect.path, dispatch, 'ConfigLoaded')
      break

    case 'WatchConfig':
      watchConfig(effect.path, dispatch, state)
      break

    case 'StartServer':
      startServer(effect.config, dispatch, state)
      break

    case 'StopServer':
      stopServer(state)
      break

    case 'AddLazyRoute':
      addLazyRoute(effect.def, dispatch, state)
      break

    case 'SpawnWorker':
      spawnWorker(
        effect.def,
        effect.replica,
        effect.generation,
        dispatch,
        state,
      )
      break

    case 'KillWorker':
      killWorker(effect.name, effect.replica, state)
      break

    case 'AddRoute':
    case 'UpdateRoute':
      addOrUpdateRoute(effect.def, effect.type, state)
      break

    case 'RemoveRoute':
      removeRoute(effect.routeId, state)
      break

    case 'UnregisterInterceptor':
      safeUnregisterInterceptor(effect.key)
      break

    case 'Log':
      log(effect.level, effect.message)
      break
  }
}

async function loadConfig(
  path: string,
  dispatch: (event: AppEvent) => void,
  successType: 'ConfigLoaded' | 'ConfigChanged',
): Promise<void> {
  try {
    const raw = await Deno.readTextFile(path)
    dispatch({
      type: successType,
      config: await materializeConfig(JSON.parse(raw)),
    })
  } catch (err) {
    const prefix = successType === 'ConfigChanged' ? 'hot-reload: ' : ''
    dispatch({ type: 'ConfigError', error: `${prefix}${err}` })
  }
}

function watchConfig(
  path: string,
  dispatch: (event: AppEvent) => void,
  state: AppState,
): void {
  state.watcher?.close()
  const watcher = Deno.watchFs(path)
  state.watcher = watcher

  void (async () => {
    for await (const event of watcher) {
      if (event.kind === 'modify' || event.kind === 'create') {
        await loadConfig(path, dispatch, 'ConfigChanged')
      }
    }
  })()
}

function startServer(
  config: NonNullable<AppState['config']>,
  dispatch: (event: AppEvent) => void,
  state: AppState,
): void {
  try {
    const server = new LonesomeServer()
    server.start({
      threads: config.threads ?? 0,
      workStealing: config.workStealing ?? false,
      listeners: config.listeners,
    })
    state.server = server
    log(
      'info',
      `server started on ${
        config.listeners.map((listener) => listener.addr).join(', ')
      }`,
    )
  } catch (err) {
    dispatch({ type: 'ConfigError', error: `server start failed: ${err}` })
  }
}

function stopServer(state: AppState): void {
  if (!state.server) return

  try {
    ;(state.server as LonesomeServer).stop()
  } catch {
    // ok: stop can be a no-op on some platforms/builds.
  }
  state.server = null
  log('info', 'server stopped')
}

function addLazyRoute(
  worker: WorkerDef,
  dispatch: (event: AppEvent) => void,
  state: AppState,
): void {
  if (!state.server) return

  const routeId = routeIdFor(worker.name)
  const interceptorKey = lazyInterceptorKeyFor(worker.name)

  try {
    safeUnregisterInterceptor(interceptorKey, false)
    registerInterceptor(interceptorKey, async () => {
      if (!state.readyWorkers.has(worker.name)) {
        try {
          await ensureWorkerActive(worker.name, dispatch)
        } catch (err) {
          return {
            action: 'respond',
            status: 503,
            body: `worker ${worker.name} unavailable: ${err}`,
            contentType: 'text/plain',
          }
        }
      }
      return { action: 'continue' }
    })

    addOrUpdateServerRoute(worker, [
      { type: 'interceptor', config: { key: interceptorKey } },
      ...(worker.middlewares ?? []),
    ], state)

    state.workerRoutes.set(worker.name, routeId)
    log(
      'info',
      `lazy route registered: ${routeId} (interceptor: ${interceptorKey})`,
    )
  } catch (err) {
    log('error', `lazy route failed (${routeId}): ${err}`)
  }
}

function spawnWorker(
  def: WorkerDef,
  replica: number,
  generation: number,
  dispatch: (event: AppEvent) => void,
  state: AppState,
): void {
  const appRoot = new URL('..', import.meta.url).href
  const workerUrl = new URL('./worker.ts', appRoot).href

  const worker = new Worker(workerUrl, {
    type: 'module',
    name: def.name,
    deno: { permissions: def.permissions ?? 'none' },
  })

  worker.onmessage = (event: MessageEvent) => {
    const msg = event.data
    if (msg?.type === 'ready') {
      dispatch({ type: 'WorkerReady', name: def.name, replica, generation })
    } else if (msg?.type === 'error') {
      dispatch({
        type: 'WorkerCrashed',
        name: def.name,
        replica,
        generation,
        reason: msg.reason ?? 'unknown',
      })
    }
  }

  worker.onerror = (err: ErrorEvent) => {
    dispatch({
      type: 'WorkerCrashed',
      name: def.name,
      replica,
      generation,
      reason: err.message,
    })
  }

  worker.postMessage({
    type: 'init',
    config: { ...def, address: requireAddresses(def)[replica] },
  })
  state.workers.set(instanceKey(def.name, replica), {
    worker,
    config: def,
    generation,
    replica,
  })
  log('info', `worker spawned: ${def.name}#${replica}@${generation}`)
}

function killWorker(
  name: string,
  replica: number | undefined,
  state: AppState,
): void {
  const keys = replica === undefined
    ? [...state.workers.keys()].filter((key) =>
      key === name || key.startsWith(`${name}#`)
    )
    : [instanceKey(name, replica)]

  for (const key of keys) {
    const handle = state.workers.get(key)
    if (!handle) continue

    try {
      handle.worker.postMessage({ type: 'stop' })
    } catch {
      // ok: worker might already be gone.
    }
    handle.worker.terminate()
    state.workers.delete(key)
    log(
      'info',
      `worker stopped: ${name}#${handle.replica}@${handle.generation}`,
    )
  }
}

function addOrUpdateRoute(
  worker: WorkerDef,
  type: 'AddRoute' | 'UpdateRoute',
  state: AppState,
): void {
  if (!state.server) return

  const routeId = routeIdFor(worker.name)
  try {
    addOrUpdateServerRoute(worker, worker.middlewares ?? [], state)
    log(
      'info',
      `route ${type === 'UpdateRoute' ? 'updated' : 'added'}: ${routeId} → ${
        requireAddresses(worker).map(formatAddress).join(', ')
      }`,
    )
  } catch (err) {
    log('error', `route failed (${routeId}): ${err}`)
  }
}

function addOrUpdateServerRoute(
  worker: WorkerDef,
  middlewares: Array<{ type: string; config: unknown }>,
  state: AppState,
): void {
  ;(state.server as LonesomeServer).addOrUpdate({
    id: routeIdFor(worker.name),
    matcher: worker.matcher,
    middlewares,
    upstreams: upstreamsFor(worker),
    loadBalancer: state.config?.loadBalancer ?? { algorithm: 'round_robin' },
  })
}

function removeRoute(routeId: string, state: AppState): void {
  if (!state.server) return

  try {
    ;(state.server as LonesomeServer).remove(routeId)
  } catch {
    // ok: route may already be absent.
  }
  log('info', `route removed: ${routeId}`)
}

function safeUnregisterInterceptor(key: string, logResult = true): void {
  try {
    const removed = unregisterInterceptor(key)
    if (logResult && removed) log('info', `interceptor unregistered: ${key}`)
  } catch (err) {
    if (logResult) {
      log('error', `unregister interceptor failed (${key}): ${err}`)
    }
  }
}

function log(level: string, message: string): void {
  const ts = new Date().toISOString()
  const tag = level.toUpperCase().padEnd(5)
  console.log(`${ts}  ${tag}  ${message}`)
}
