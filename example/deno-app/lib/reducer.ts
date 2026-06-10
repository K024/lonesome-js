import type {
  AppConfig,
  AppEffect,
  AppEvent,
  AppState,
  WorkerDef,
} from './types.ts'
import { markWorkerFailed, markWorkerReady } from './lazy-registry.ts'
import {
  instanceKey,
  lazyInterceptorKeyFor,
  routeIdFor,
} from './worker-route.ts'

export function reduce(
  state: AppState,
  event: AppEvent,
): [AppState, AppEffect[]] {
  switch (event.type) {
    case 'Init':
      return [state, [
        { type: 'LoadConfig', path: event.configPath },
        { type: 'WatchConfig', path: event.configPath },
        { type: 'Log', level: 'info', message: 'lonesome-deno started' },
      ]]

    case 'ConfigLoaded':
      return initializeConfig(state, event.config)

    case 'ConfigError':
      return [state, [{
        type: 'Log',
        level: 'error',
        message: `config error: ${event.error}`,
      }]]

    case 'ConfigChanged':
      return enqueueConfig(state, event.config)

    case 'ReconcileNext':
      return reconcileNext(state)

    case 'LazyWorkerRequested':
      return activateLazyWorker(state, event.name)

    case 'WorkerReady':
      return markReady(state, event.name, event.replica, event.generation)

    case 'WorkerCrashed':
      return markCrashed(
        state,
        event.name,
        event.replica,
        event.generation,
        event.reason,
      )

    case 'Shutdown':
      return shutdown(state)

    default:
      return [state, []]
  }
}

function initializeConfig(
  state: AppState,
  config: AppConfig,
): [AppState, AppEffect[]] {
  const workerGenerations = new Map<string, number>()
  const effects: AppEffect[] = []

  if (config.listeners.length > 0) {
    effects.push({ type: 'StartServer', config })
  }

  for (const worker of config.workers) {
    const generation = nextGeneration(workerGenerations, worker.name)
    effects.push(...effectsForNewWorker(worker, generation))
  }

  effects.push(...configWarnings(config))
  effects.push({
    type: 'Log',
    level: 'info',
    message: `config loaded: ${config.workers.length} worker(s)`,
  })

  return [{
    config,
    pendingConfig: null,
    server: state.server,
    workers: new Map(),
    readyWorkers: new Set(),
    readyReplicas: new Map(),
    workerRoutes: new Map(),
    watcher: state.watcher,
    workerGenerations,
    transitioningWorker: null,
  }, effects]
}

function enqueueConfig(
  state: AppState,
  config: AppConfig,
): [AppState, AppEffect[]] {
  const effects: AppEffect[] = [
    {
      type: 'Log',
      level: 'info',
      message: 'config changed, queued reconciliation...',
    },
    ...configWarnings(config),
  ]

  if (!state.transitioningWorker) {
    effects.push({ type: 'Dispatch', event: { type: 'ReconcileNext' } })
  }

  return [{ ...state, pendingConfig: config }, effects]
}

function reconcileNext(state: AppState): [AppState, AppEffect[]] {
  if (state.transitioningWorker || !state.pendingConfig) return [state, []]
  if (!state.config) return initializeConfig(state, state.pendingConfig)

  const current = state.config
  const target = state.pendingConfig
  const effects: AppEffect[] = []
  let nextConfig = current

  if (!deepEqual(current.listeners, target.listeners)) {
    effects.push({ type: 'StopServer' })
    if (target.listeners.length > 0) {
      effects.push({ type: 'StartServer', config: target })
    }
    nextConfig = { ...nextConfig, listeners: target.listeners }
  }

  if (
    current.threads !== target.threads ||
    current.workStealing !== target.workStealing
  ) {
    nextConfig = {
      ...nextConfig,
      threads: target.threads,
      workStealing: target.workStealing,
    }
  }

  if (!deepEqual(current.workerTransport, target.workerTransport)) {
    nextConfig = { ...nextConfig, workerTransport: target.workerTransport }
  }

  const currentByName = indexWorkers(current.workers)
  const targetByName = indexWorkers(target.workers)

  for (const name of currentByName.keys()) {
    if (!targetByName.has(name)) {
      return removeOneWorker(state, nextConfig, name, effects)
    }
  }

  for (const targetWorker of target.workers) {
    const currentWorker = currentByName.get(targetWorker.name)
    if (!currentWorker) {
      return addOneWorker(state, nextConfig, targetWorker, effects)
    }

    if (!deepEqual(currentWorker, targetWorker)) {
      return changeOneWorker(state, nextConfig, targetWorker, effects)
    }
  }

  if (!deepEqual(nextConfig, current)) {
    effects.push({ type: 'Dispatch', event: { type: 'ReconcileNext' } })
    return [{ ...state, config: nextConfig }, effects]
  }

  effects.push({
    type: 'Log',
    level: 'info',
    message: 'config reconciliation complete',
  })
  return [{ ...state, pendingConfig: null }, effects]
}

function addOneWorker(
  state: AppState,
  baseConfig: AppConfig,
  worker: WorkerDef,
  prefixEffects: AppEffect[],
): [AppState, AppEffect[]] {
  const workerGenerations = new Map(state.workerGenerations)
  const generation = nextGeneration(workerGenerations, worker.name)
  const config = { ...baseConfig, workers: [...baseConfig.workers, worker] }
  const effects = [
    ...prefixEffects,
    ...effectsForNewWorker(worker, generation),
  ]

  if (worker.lazy) {
    effects.push({ type: 'Dispatch', event: { type: 'ReconcileNext' } })
    return [{ ...state, config, workerGenerations }, effects]
  }

  return [{
    ...state,
    config,
    workerGenerations,
    transitioningWorker: worker.name,
  }, effects]
}

function changeOneWorker(
  state: AppState,
  baseConfig: AppConfig,
  worker: WorkerDef,
  prefixEffects: AppEffect[],
): [AppState, AppEffect[]] {
  const workerGenerations = new Map(state.workerGenerations)
  const generation = nextGeneration(workerGenerations, worker.name)
  const readyWorkers = new Set(state.readyWorkers)
  const readyReplicas = new Map(state.readyReplicas)
  readyWorkers.delete(worker.name)
  readyReplicas.delete(worker.name)

  const config = {
    ...baseConfig,
    workers: baseConfig.workers.map((existing) =>
      existing.name === worker.name ? worker : existing
    ),
  }

  const effects: AppEffect[] = [
    ...prefixEffects,
    { type: 'KillWorker', name: worker.name },
    { type: 'UnregisterInterceptor', key: lazyInterceptorKeyFor(worker.name) },
    ...effectsForNewWorker(worker, generation),
  ]

  if (worker.lazy) {
    effects.push({ type: 'Dispatch', event: { type: 'ReconcileNext' } })
    return [{
      ...state,
      config,
      workerGenerations,
      readyWorkers,
      readyReplicas,
    }, effects]
  }

  return [{
    ...state,
    config,
    workerGenerations,
    readyWorkers,
    readyReplicas,
    transitioningWorker: worker.name,
  }, effects]
}

function removeOneWorker(
  state: AppState,
  baseConfig: AppConfig,
  name: string,
  prefixEffects: AppEffect[],
): [AppState, AppEffect[]] {
  const workerGenerations = new Map(state.workerGenerations)
  const readyWorkers = new Set(state.readyWorkers)
  const readyReplicas = new Map(state.readyReplicas)
  const routes = new Map(state.workerRoutes)

  workerGenerations.delete(name)
  readyWorkers.delete(name)
  readyReplicas.delete(name)

  const routeId = routes.get(name)
  if (routeId) routes.delete(name)

  const config = {
    ...baseConfig,
    workers: baseConfig.workers.filter((worker) => worker.name !== name),
  }
  const effects: AppEffect[] = [
    ...prefixEffects,
    { type: 'KillWorker', name },
    { type: 'UnregisterInterceptor', key: lazyInterceptorKeyFor(name) },
  ]
  if (routeId) effects.push({ type: 'RemoveRoute', routeId })
  effects.push({ type: 'Dispatch', event: { type: 'ReconcileNext' } })

  return [{
    ...state,
    config,
    workerGenerations,
    readyWorkers,
    readyReplicas,
    workerRoutes: routes,
  }, effects]
}

function activateLazyWorker(
  state: AppState,
  name: string,
): [AppState, AppEffect[]] {
  const worker = state.config?.workers.find((w) => w.name === name)
  if (!worker) return [state, []]

  const workerGenerations = new Map(state.workerGenerations)
  const generation = nextGeneration(workerGenerations, name)

  return [{ ...state, workerGenerations, transitioningWorker: name }, [
    { type: 'Log', level: 'info', message: `lazy worker activating: ${name}` },
    { type: 'SpawnWorker', def: worker, replica: 0, generation },
  ]]
}

function markReady(
  state: AppState,
  name: string,
  replica: number,
  generation: number,
): [AppState, AppEffect[]] {
  if (!isCurrentGeneration(state, name, generation)) return [state, []]

  const worker = state.config?.workers.find((w) => w.name === name)
  if (!worker) return [state, []]

  const readyReplicas = cloneReadyReplicas(state.readyReplicas)
  const ready = readyReplicas.get(name) ?? new Set<number>()
  ready.add(replica)
  readyReplicas.set(name, ready)

  if (ready.size < replicaCount(worker)) {
    return [{ ...state, readyReplicas }, [
      {
        type: 'Log',
        level: 'info',
        message: `worker replica ready: ${name}#${replica}`,
      },
    ]]
  }

  const routes = new Map(state.workerRoutes)
  routes.set(name, routeIdFor(name))

  markWorkerReady(name)

  const readyWorkers = new Set(state.readyWorkers)
  readyWorkers.add(name)

  return [{
    ...state,
    readyWorkers,
    readyReplicas,
    workerRoutes: routes,
    transitioningWorker: null,
  }, [
    {
      type: 'Log',
      level: 'info',
      message: `worker ready: ${name} (${ready.size}/${
        replicaCount(worker)
      } replicas)`,
    },
    ...(worker.lazy
      ? [
        { type: 'UpdateRoute' as const, def: worker },
        {
          type: 'UnregisterInterceptor' as const,
          key: lazyInterceptorKeyFor(name),
        },
      ]
      : [{ type: 'AddRoute' as const, def: worker }]),
    { type: 'Dispatch', event: { type: 'ReconcileNext' } },
  ]]
}

function markCrashed(
  state: AppState,
  name: string,
  replica: number,
  generation: number,
  reason: string,
): [AppState, AppEffect[]] {
  if (!isCurrentGeneration(state, name, generation)) return [state, []]

  markWorkerFailed(name, new Error(reason))

  const workers = new Map(state.workers)
  workers.delete(instanceKey(name, replica))

  const routes = new Map(state.workerRoutes)
  const routeId = routes.get(name)
  if (routeId) routes.delete(name)

  const readyWorkers = new Set(state.readyWorkers)
  readyWorkers.delete(name)
  const readyReplicas = cloneReadyReplicas(state.readyReplicas)
  readyReplicas.delete(name)

  const effects: AppEffect[] = [
    {
      type: 'Log',
      level: 'error',
      message: `worker crashed: ${name}#${replica} — ${reason}`,
    },
  ]
  if (routeId) effects.push({ type: 'RemoveRoute', routeId })

  return [{
    ...state,
    readyWorkers,
    readyReplicas,
    workers,
    workerRoutes: routes,
    transitioningWorker: null,
  }, effects]
}

function shutdown(state: AppState): [AppState, AppEffect[]] {
  const effects: AppEffect[] = [
    { type: 'Log', level: 'info', message: 'shutting down...' },
    { type: 'StopServer' },
  ]
  for (const [key] of state.workers) {
    const [name, replica] = parseInstanceKey(key)
    effects.push({ type: 'KillWorker', name, replica })
  }
  return [state, effects]
}

function configWarnings(config: AppConfig): AppEffect[] {
  const effects: AppEffect[] = []
  const transport = config.workerTransport ?? { kind: 'loopback' }
  const hasLazyWorkers = config.workers.some((worker) => worker.lazy)
  const forcedEagerWorkers = config.workers
    .filter((worker) => worker.lazyForcedOff)
    .map((worker) => worker.name)

  if (transport.kind === 'loopback' && hasLazyWorkers) {
    effects.push({
      type: 'Log',
      level: 'warn',
      message:
        'lazy workers use pre-allocated loopback ports; availability is checked at config load, but the port can be taken before lazy activation. If this matters, use workerTransport.kind="unix" or disable lazy for those workers.',
    })
  }

  if (forcedEagerWorkers.length > 0) {
    effects.push({
      type: 'Log',
      level: 'warn',
      message:
        `workers with replicas > 1 cannot be lazy; forced lazy=false for: ${
          forcedEagerWorkers.join(', ')
        }`,
    })
  }

  return effects
}

function effectsForNewWorker(
  worker: WorkerDef,
  generation: number,
): AppEffect[] {
  if (worker.lazy) return [{ type: 'AddLazyRoute', def: worker }]

  const effects: AppEffect[] = []
  for (let replica = 0; replica < replicaCount(worker); replica++) {
    effects.push({ type: 'SpawnWorker', def: worker, replica, generation })
  }
  return effects
}

function nextGeneration(
  generations: Map<string, number>,
  name: string,
): number {
  const next = (generations.get(name) ?? 0) + 1
  generations.set(name, next)
  return next
}

function isCurrentGeneration(
  state: AppState,
  name: string,
  generation: number,
): boolean {
  return state.workerGenerations.get(name) === generation
}

function replicaCount(worker: WorkerDef): number {
  return Math.max(1, Math.floor(worker.replicas ?? 1))
}

function cloneReadyReplicas(
  source: Map<string, Set<number>>,
): Map<string, Set<number>> {
  return new Map(
    [...source].map(([name, replicas]) => [name, new Set(replicas)]),
  )
}

function indexWorkers(workers: WorkerDef[]): Map<string, WorkerDef> {
  return new Map(workers.map((worker) => [worker.name, worker]))
}

function parseInstanceKey(key: string): [string, number] {
  const idx = key.lastIndexOf('#')
  if (idx < 0) return [key, 0]
  return [key.slice(0, idx), Number(key.slice(idx + 1))]
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
