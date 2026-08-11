import { pathToFileURL } from 'node:url'
import {
  LonesomeServer,
  registerInterceptor,
  unregisterInterceptor,
} from 'npm:lonesome-js@0.2'
import type {
  AppConfig,
  FunctionDef,
  Middleware,
  WorkerHandle,
} from './types.ts'
import { abs, join, loadConfig, watchPaths } from './config.ts'
import {
  formatAddress,
  instanceKey,
  lazyInterceptorKeyFor,
  requireAddresses,
  routeIdFor,
  upstreamsFor,
} from './worker-route.ts'
import { LogRing } from './logs.ts'
import { AdminServer } from './admin.ts'
import type { AdminOptions } from './admin.ts'

const MAX_RESTARTS = 5

type RuntimeEvent =
  | { type: 'init' }
  | { type: 'config-loaded'; config: AppConfig }
  | { type: 'config-error'; error: string }
  | { type: 'config-changed' }
  | { type: 'activate'; name: string }
  | { type: 'worker-ready'; name: string; replica: number; generation: number }
  | {
    type: 'worker-crashed'
    name: string
    replica: number
    generation: number
    reason: string
  }
  | { type: 'shutdown' }

interface Waiter {
  promise: Promise<void>
  resolve: () => void
  reject: (err: Error) => void
}

export interface RuntimeOptions {
  cwd: string
  configPath: string
}

export interface FunctionStatus {
  name: string
  handler: string
  matcher: { rule: string; priority?: number }
  replicas: number
  readyReplicas: number
  lazy: boolean
  timeoutMs?: number
  status: 'ready' | 'spawning' | 'lazy' | 'degraded'
  addresses?: string[]
  permissions?: unknown
}

export interface RuntimeSnapshot {
  uptimeSec: number
  server: { running: boolean; routeCount: number; listeners: string[] } | null
  functions: FunctionStatus[]
  routes: Array<{ name: string; routeId: string }>
  admin?: { listen?: string; hasToken: boolean }
}

export class Runtime {
  private readonly cwd: string
  private readonly configPath: string
  readonly logs = new LogRing()

  private current: AppConfig | null = null
  private pending: AppConfig | null = null
  private server: LonesomeServer | null = null
  private admin: AdminServer | null = null
  private startedAt = Date.now()
  private workers = new Map<string, WorkerHandle>()
  private readyReplicas = new Map<string, Set<number>>()
  private routes = new Map<string, string>()
  private generations = new Map<string, number>()
  private restartTries = new Map<string, number>()
  private waiters = new Map<string, Waiter>()
  private watcher: Deno.FsWatcher | null = null

  private queue: RuntimeEvent[] = []
  private pumping = false
  private reconciling = false
  private shuttingDown = false
  private shutdownPromise: Promise<void> | null = null
  private shutdownResolve: (() => void) | null = null

  constructor(opts: RuntimeOptions) {
    this.cwd = opts.cwd
    this.configPath = abs(opts.cwd, opts.configPath)
  }

  get functionsDir(): string {
    return this.current?.functionsDir ?? join(this.cwd, 'functions')
  }

  start(): void {
    this.enqueue({ type: 'init' })
  }

  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = new Promise((resolve) => {
        this.shutdownResolve = resolve
      })
      this.enqueue({ type: 'shutdown' })
    }
    return this.shutdownPromise
  }

  private enqueue(event: RuntimeEvent): void {
    if (this.shuttingDown && event.type !== 'shutdown') return
    this.queue.push(event)
    this.pump()
  }

  private pump(): void {
    if (this.pumping) return
    this.pumping = true
    void (async () => {
      try {
        while (this.queue.length) {
          const event = this.queue.shift()!
          try {
            await this.handle(event)
          } catch (err) {
            this.log('error', `event "${event.type}" failed: ${err}`)
          }
        }
      } finally {
        this.pumping = false
        if (this.queue.length) this.pump()
      }
    })()
  }

  private async handle(event: RuntimeEvent): Promise<void> {
    switch (event.type) {
      case 'init':
        await this.onInit()
        break
      case 'config-loaded':
        await this.onConfigLoaded(event.config)
        break
      case 'config-error':
        this.onConfigError(event.error)
        break
      case 'config-changed':
        await this.onConfigChanged()
        break
      case 'activate':
        this.onActivate(event.name)
        break
      case 'worker-ready':
        this.onWorkerReady(event)
        break
      case 'worker-crashed':
        this.onWorkerCrashed(event)
        break
      case 'shutdown':
        await this.onShutdown()
        break
    }
  }

  private async onInit(): Promise<void> {
    try {
      const config = await loadConfig({
        cwd: this.cwd,
        configPath: this.configPath,
      })
      this.enqueue({ type: 'config-loaded', config })
    } catch (err) {
      this.enqueue({ type: 'config-error', error: String(err) })
    }
    this.refreshWatcher()
  }

  private async onConfigLoaded(config: AppConfig): Promise<void> {
    if (!this.current) {
      this.current = config
      await this.startServer(config)
      this.spawnFunctions(config)
      this.syncAdmin(config)
      this.log('info', `config loaded: ${config.functions.length} function(s)`)
      this.refreshWatcher()
      return
    }
    this.pending = config
    await this.reconcile()
    if (this.current) this.syncAdmin(this.current)
    this.refreshWatcher()
  }

  private syncAdmin(config: AppConfig): void {
    const want = config.admin
    const current = this.admin
    if (!want || !want.listen) {
      if (current) {
        current.stop()
        this.admin = null
        this.log('info', 'admin server stopped')
      }
      return
    }
    const opts: AdminOptions = {
      listen: want.listen,
      token: want.token ?? '',
      staticDir: want.staticDir,
    }
    if (current?.matches(opts)) return
    current?.stop()
    try {
      const next = new AdminServer(this, opts)
      next.start()
      this.admin = next
      this.log('info', `admin server started on ${want.listen}`)
    } catch (err) {
      this.admin = null
      this.log(
        'error',
        `admin server failed to start on ${want.listen}: ${err}`,
      )
    }
  }

  private onConfigError(error: string): void {
    this.log('error', `config error: ${error}`)
  }

  private async onConfigChanged(): Promise<void> {
    await sleep(60)
    try {
      const config = await loadConfig({
        cwd: this.cwd,
        configPath: this.configPath,
      })
      this.enqueue({ type: 'config-loaded', config })
    } catch (err) {
      this.enqueue({ type: 'config-error', error: `hot-reload: ${err}` })
    }
  }

  private async reconcile(): Promise<void> {
    if (this.reconciling || !this.pending || !this.current) return
    this.reconciling = true
    try {
      const target = this.pending
      const current = this.current
      const curByName = indexByName(current.functions)
      const tgtByName = indexByName(target.functions)

      if (!this.server) {
        await this.startServer(target)
        if (this.server) this.restoreRoutes(target, curByName)
      } else if (startupConfigChanged(current, target)) {
        this.log(
          'warn',
          'startup config changed (listeners/threads/workStealing/loadBalancer); ' +
            'hot-reload only covers functions — restart the process to apply',
        )
      }
      this.pending = null

      for (const name of curByName.keys()) {
        if (!tgtByName.has(name)) this.removeFunction(name)
      }
      for (const [name, def] of tgtByName) {
        const curDef = curByName.get(name)
        if (!curDef) {
          this.spawnFunction(def)
          continue
        }
        if (!deepEqual(curDef, def)) {
          this.changeFunction(def)
        }
      }

      this.current = target
      this.log('info', 'config reconciliation complete')
    } finally {
      this.reconciling = false
    }
  }

  private spawnFunctions(config: AppConfig): void {
    for (const def of config.functions) this.spawnFunction(def)
  }

  private spawnFunction(def: FunctionDef): void {
    if (def.lazy) {
      this.addLazyRoute(def)
      return
    }
    const generation = this.nextGeneration(def.name)
    for (let replica = 0; replica < replicaCount(def); replica++) {
      this.spawnWorker(def, replica, generation)
    }
  }

  // Re-register routes for functions that survive unchanged — used only after
  // the proxy server was (re)started, since a fresh LonesomeServer has no routes.
  private restoreRoutes(
    target: AppConfig,
    curByName: Map<string, FunctionDef>,
  ): void {
    for (const def of target.functions) {
      const cur = curByName.get(def.name)
      if (!cur || !deepEqual(cur, def)) continue
      if (def.lazy && !this.isReady(def.name)) {
        this.addLazyRoute(def)
      } else if (this.isReady(def.name)) {
        this.registerRoute(def)
      }
    }
  }

  private changeFunction(def: FunctionDef): void {
    this.removeFunction(def.name)
    this.spawnFunction(def)
  }

  private removeFunction(name: string): void {
    this.killWorkers(name)
    this.readyReplicas.delete(name)
    this.removeRoute(name)
    this.safeUnregister(lazyInterceptorKeyFor(name))
    this.rejectWaiters(name, new Error(`function ${name} removed`))
    this.restartTries.delete(name)
  }

  private spawnWorker(
    def: FunctionDef,
    replica: number,
    generation: number,
  ): void {
    const workerUrl = new URL('../worker.ts', import.meta.url).href
    const address = requireAddresses(def)[replica]

    let worker: Worker
    try {
      worker = new Worker(workerUrl, {
        type: 'module',
        name: def.name,
        deno: {
          permissions:
            (def.permissions ?? 'none') as Deno.PermissionOptionsObject,
        },
      })
    } catch (err) {
      this.log('error', `worker spawn failed ${def.name}#${replica}: ${err}`)
      this.rejectWaiters(def.name, new Error(String(err)))
      return
    }

    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type === 'ready') {
        this.enqueue({
          type: 'worker-ready',
          name: def.name,
          replica,
          generation,
        })
      } else if (msg?.type === 'error') {
        this.enqueue({
          type: 'worker-crashed',
          name: def.name,
          replica,
          generation,
          reason: msg.reason ?? 'unknown',
        })
      } else if (msg?.type === 'log') {
        this.log(
          msg.level === 'error'
            ? 'error'
            : msg.level === 'warn'
            ? 'warn'
            : 'info',
          `[${def.name}#${replica}] ${msg.message}`,
        )
      }
    }
    worker.onerror = (err: ErrorEvent) => {
      this.enqueue({
        type: 'worker-crashed',
        name: def.name,
        replica,
        generation,
        reason: err.message,
      })
    }

    worker.postMessage({
      type: 'init',
      config: {
        name: def.name,
        handler: pathToFileURL(def.handler).href,
        address,
        env: def.env,
        timeoutMs: def.timeoutMs,
      },
    })

    this.workers.set(instanceKey(def.name, replica), {
      worker,
      def,
      generation,
      replica,
    })
    this.log('info', `worker spawned: ${def.name}#${replica}@${generation}`)
  }

  private killWorkers(name: string): void {
    for (const [key, handle] of this.workers) {
      if (key !== name && !key.startsWith(`${name}#`)) continue
      try {
        handle.worker.postMessage({ type: 'stop' })
      } catch {
        // worker already gone
      }
      handle.worker.terminate()
      this.workers.delete(key)
      this.log('info', `worker stopped: ${key}@${handle.generation}`)
    }
  }

  private onWorkerReady(event: {
    name: string
    replica: number
    generation: number
  }): void {
    if (this.generations.get(event.name) !== event.generation) return
    const handle = this.workers.get(instanceKey(event.name, event.replica))
    if (!handle) return

    const ready = this.readyReplicas.get(event.name) ?? new Set<number>()
    ready.add(event.replica)
    this.readyReplicas.set(event.name, ready)
    this.restartTries.delete(event.name)

    if (ready.size < replicaCount(handle.def)) {
      this.log(
        'info',
        `replica ready: ${event.name}#${event.replica} (${ready.size}/${
          replicaCount(handle.def)
        })`,
      )
      return
    }

    this.registerRoute(handle.def)
    if (handle.def.lazy) {
      this.safeUnregister(lazyInterceptorKeyFor(event.name))
    }
    this.resolveWaiters(event.name)
    this.log('info', `function ready: ${event.name}`)
  }

  private onWorkerCrashed(event: {
    name: string
    replica: number
    generation: number
    reason: string
  }): void {
    if (this.generations.get(event.name) !== event.generation) return

    this.workers.delete(instanceKey(event.name, event.replica))
    this.readyReplicas.delete(event.name)
    this.removeRoute(event.name)
    this.rejectWaiters(event.name, new Error(event.reason))
    this.log(
      'error',
      `function crashed: ${event.name}#${event.replica} — ${event.reason}`,
    )

    const def = this.current?.functions.find((fn) => fn.name === event.name)
    if (!def || this.shuttingDown || this.isReady(event.name)) return

    const tries = (this.restartTries.get(event.name) ?? 0) + 1
    this.restartTries.set(event.name, tries)
    if (tries > MAX_RESTARTS) {
      this.log(
        'error',
        `giving up on ${event.name} after ${MAX_RESTARTS} crashes`,
      )
      return
    }

    setTimeout(() => {
      if (this.shuttingDown) return
      if (this.generations.get(event.name) !== event.generation) return
      this.spawnWorker(def, event.replica, event.generation)
    }, 1000 * tries)
  }

  private onActivate(name: string): void {
    const def = this.current?.functions.find((fn) => fn.name === name)
    if (!def) {
      this.rejectWaiters(name, new Error(`function ${name} not found`))
      return
    }
    this.log('info', `lazy function activating: ${name}`)
    const generation = this.nextGeneration(name)
    this.spawnWorker(def, 0, generation)
  }

  private activate(name: string): Promise<void> {
    const existing = this.waiters.get(name)
    if (existing) return existing.promise

    let resolve!: () => void
    let reject!: (err: Error) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    this.waiters.set(name, { promise, resolve, reject })
    this.enqueue({ type: 'activate', name })
    return promise
  }

  private addLazyRoute(def: FunctionDef): void {
    if (!this.server) return
    const key = lazyInterceptorKeyFor(def.name)
    this.safeUnregister(key, false)

    try {
      registerInterceptor(key, async () => {
        if (this.isReady(def.name)) return { action: 'continue' }
        try {
          await this.activate(def.name)
          return { action: 'continue' }
        } catch (err) {
          return {
            action: 'respond',
            status: 503,
            body: `function ${def.name} unavailable: ${err}`,
            contentType: 'text/plain; charset=utf-8',
          }
        }
      })
    } catch (err) {
      this.log('error', `lazy interceptor failed (${def.name}): ${err}`)
      return
    }

    this.registerRoute(def, [
      { type: 'interceptor', config: { key } },
      ...(def.middlewares ?? []),
    ])
    this.log('info', `lazy route registered: ${routeIdFor(def.name)}`)
  }

  private registerRoute(def: FunctionDef, middlewares?: Middleware[]): void {
    if (!this.server) return
    const routeId = routeIdFor(def.name)
    this.server.addOrUpdate({
      id: routeId,
      matcher: def.matcher,
      middlewares: middlewares ?? def.middlewares ?? [],
      upstreams: upstreamsFor(def),
      loadBalancer: this.current?.loadBalancer ?? { algorithm: 'round_robin' },
    })
    this.routes.set(def.name, routeId)
    this.log(
      'info',
      `route registered: ${routeId} -> ${
        requireAddresses(def).map(formatAddress).join(', ')
      }`,
    )
  }

  private removeRoute(name: string): void {
    const routeId = this.routes.get(name)
    if (!routeId || !this.server) return
    try {
      this.server.remove(routeId)
    } catch {
      // route may already be absent
    }
    this.routes.delete(name)
    this.log('info', `route removed: ${routeId}`)
  }

  private async startServer(config: AppConfig): Promise<void> {
    if (!config.listeners.length) return
    try {
      const server = new LonesomeServer()
      server.start({
        threads: config.threads ?? 0,
        workStealing: config.workStealing ?? false,
        listeners: config.listeners,
      })
      this.server = server
      this.log(
        'info',
        `server started on ${config.listeners.map((l) => l.addr).join(', ')}`,
      )
    } catch (err) {
      this.log('error', `server start failed: ${err}`)
    }
  }

  private async onShutdown(): Promise<void> {
    this.shuttingDown = true
    this.log('info', 'shutting down...')
    if (this.watcher) {
      try {
        this.watcher.close()
      } catch {
        // already closed
      }
      this.watcher = null
    }
    for (const name of this.waiters.keys()) {
      this.rejectWaiters(name, new Error('shutdown'))
    }
    for (
      const name of new Set(
        [...this.workers.keys()].map((key) => key.split('#', 1)[0]),
      )
    ) {
      this.killWorkers(name)
    }
    if (this.server) {
      try {
        await this.server.stop()
      } catch {
        // stop is best-effort
      }
      this.server = null
    }
    this.admin?.stop()
    this.admin = null
    this.current = null
    this.pending = null
    this.shutdownResolve?.()
  }

  private refreshWatcher(): void {
    const functionsDir = this.current?.functionsDir ??
      join(this.cwd, 'functions')
    const paths = [this.configPath, functionsDir]
    if (this.watcher) {
      try {
        this.watcher.close()
      } catch {
        // already closed
      }
      this.watcher = null
    }
    try {
      this.watcher = watchPaths(
        paths,
        () => this.enqueue({ type: 'config-changed' }),
      )
    } catch (err) {
      this.log('error', `file watch failed: ${err}`)
    }
  }

  private isReady(name: string): boolean {
    const def = this.current?.functions.find((fn) => fn.name === name)
    if (!def) return false
    return (this.readyReplicas.get(name)?.size ?? 0) >= replicaCount(def)
  }

  private resolveWaiters(name: string): void {
    const waiter = this.waiters.get(name)
    if (waiter) {
      this.waiters.delete(name)
      waiter.resolve()
    }
  }

  private rejectWaiters(name: string, err: Error): void {
    const waiter = this.waiters.get(name)
    if (waiter) {
      this.waiters.delete(name)
      waiter.reject(err)
    }
  }

  private nextGeneration(name: string): number {
    const next = (this.generations.get(name) ?? 0) + 1
    this.generations.set(name, next)
    return next
  }

  private safeUnregister(key: string, logResult = true): void {
    try {
      const removed = unregisterInterceptor(key)
      if (logResult && removed) {
        this.log('info', `interceptor unregistered: ${key}`)
      }
    } catch {
      // best-effort
    }
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    const ts = new Date().toISOString()
    console.log(`${ts}  ${level.toUpperCase().padEnd(5)}  ${message}`)
    this.logs.push(level, 'runtime', message)
  }

  snapshot(): RuntimeSnapshot {
    const server = this.server
    return {
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      server: server
        ? {
          running: server.status().running,
          routeCount: server.status().routeCount,
          listeners: server.status().listeners.map((l) => l.addr),
        }
        : null,
      functions: (this.current?.functions ?? []).map((def) => {
        const ready = this.readyReplicas.get(def.name)?.size ?? 0
        const expected = replicaCount(def)
        const status: FunctionStatus['status'] = this.isReady(def.name)
          ? 'ready'
          : this.restartTries.has(def.name)
          ? 'degraded'
          : def.lazy
          ? 'lazy'
          : 'spawning'
        return {
          name: def.name,
          handler: def.handler,
          matcher: def.matcher,
          replicas: expected,
          readyReplicas: ready,
          lazy: def.lazy ?? false,
          timeoutMs: def.timeoutMs,
          status,
          addresses: def.addresses?.map(formatAddress),
          permissions: def.permissions,
        }
      }),
      routes: [...this.routes.entries()].map(([name, routeId]) => ({
        name,
        routeId,
      })),
      admin: this.current?.admin
        ? {
          listen: this.current.admin.listen,
          hasToken: !!this.current.admin.token,
        }
        : undefined,
    }
  }

  reload(): void {
    this.enqueue({ type: 'config-changed' })
  }
}

function indexByName(functions: FunctionDef[]): Map<string, FunctionDef> {
  return new Map(functions.map((def) => [def.name, def]))
}

function replicaCount(def: FunctionDef): number {
  return Math.max(1, Math.floor(def.replicas ?? 1))
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function startupConfigChanged(a: AppConfig, b: AppConfig): boolean {
  return (
    !deepEqual(a.listeners, b.listeners) ||
    !deepEqual(a.loadBalancer, b.loadBalancer) ||
    a.threads !== b.threads ||
    a.workStealing !== b.workStealing
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
