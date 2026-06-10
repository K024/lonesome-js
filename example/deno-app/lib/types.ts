/** Deno PermissionOptionsObject — mirrors Deno.PermissionOptionsObject for worker permissions. */
export interface WorkerPermissions {
  read?: 'inherit' | boolean | Array<string | URL>
  write?: 'inherit' | boolean | Array<string | URL>
  net?: 'inherit' | boolean | string[]
  env?: 'inherit' | boolean | string[]
  run?: 'inherit' | boolean | string[]
  ffi?: 'inherit' | boolean | Array<string | URL>
  import?: 'inherit' | boolean | string[]
  sys?: 'inherit' | boolean | string[]
}

export type WorkerTransportConfig =
  | {
    kind: 'loopback'
    hostname?: string
    startPort?: number
    maxPortAttempts?: number
  }
  | { kind: 'unix'; dir?: string; prefix?: string }

export type WorkerAddress =
  | { kind: 'loopback'; hostname: string; port: number }
  | { kind: 'unix'; path: string }

export type WorkerUpstream =
  | { kind: 'tcp'; address: string; tls: false; sni: ''; weight: 1 }
  | { kind: 'unix'; address: string; tls: false; sni: ''; weight: 1 }

export interface WorkerDef {
  name: string
  /** Entry script. Must default-export: (req: Request) => Response | Promise<Response> */
  main: string
  /** Runtime-assigned address for this concrete worker instance. */
  address?: WorkerAddress
  /** Runtime-assigned addresses for all replicas of this logical worker. */
  addresses?: WorkerAddress[]
  /** Route matcher — LonesomeServer registers ONE route per logical worker */
  matcher: { rule: string; priority?: number }
  /** Optional middlewares (applied AFTER the lazy interceptor if lazy=true) */
  middlewares?: Array<{ type: string; config: unknown }>
  permissions?: WorkerPermissions
  env?: Record<string, string>
  /** Number of identical worker instances to run. Default: 1. */
  replicas?: number
  /** If true, worker spawns on first request (via interceptor). Default: false. Forced false when replicas > 1. */
  lazy?: boolean
  /** @private Internal: true when lazy was requested but disabled because replicas > 1. */
  lazyForcedOff?: boolean
}

export interface LoadBalancerConfig {
  algorithm?: 'round_robin' | 'rr' | 'consistent_hash' | 'consistent' | 'ch'
  maxIterations?: number
  hashKeyRule?: string
}

export interface AppConfig {
  listeners: Array<{
    kind: 'tcp' | 'tls' | 'unix'
    addr: string
    certPath?: string
    keyPath?: string
  }>
  threads?: number
  workStealing?: boolean
  /** Internal transport used by worker HTTP servers. Default: { kind: 'loopback' }. */
  workerTransport?: WorkerTransportConfig
  /** Default load balancer for generated worker routes. Default: round_robin. */
  loadBalancer?: LoadBalancerConfig
  workers: WorkerDef[]
}

// ── Reducer ─────────────────────────────────────────────────

export interface WorkerHandle {
  worker: Worker
  config: WorkerDef
  generation: number
  replica: number
}

export interface AppState {
  config: AppConfig | null
  pendingConfig: AppConfig | null
  server: unknown | null
  /** instanceKey(workerName, replica) → worker handle */
  workers: Map<string, WorkerHandle>
  /** Logical worker names whose current generation has all replicas ready. */
  readyWorkers: Set<string>
  /** workerName → ready replica indexes */
  readyReplicas: Map<string, Set<number>>
  /** workerName → routeId */
  workerRoutes: Map<string, string>
  watcher: Deno.FsWatcher | null
  workerGenerations: Map<string, number>
  transitioningWorker: string | null
}

export type AppEvent =
  | { type: 'Init'; configPath: string }
  | { type: 'ConfigLoaded'; config: AppConfig }
  | { type: 'ConfigError'; error: string }
  | { type: 'ConfigChanged'; config: AppConfig }
  | { type: 'ReconcileNext' }
  /** Fired by the lazy interceptor on first request */
  | { type: 'LazyWorkerRequested'; name: string }
  | { type: 'WorkerReady'; name: string; replica: number; generation: number }
  | {
    type: 'WorkerCrashed'
    name: string
    replica: number
    generation: number
    reason: string
  }
  | { type: 'Shutdown' }

export type AppEffect =
  | { type: 'LoadConfig'; path: string }
  | { type: 'WatchConfig'; path: string }
  | { type: 'StartServer'; config: AppConfig }
  | { type: 'StopServer' }
  | { type: 'SpawnWorker'; def: WorkerDef; replica: number; generation: number }
  | { type: 'KillWorker'; name: string; replica?: number }
  /** Register the initial route + lazy interceptor (lazy workers only) */
  | { type: 'AddLazyRoute'; def: WorkerDef }
  /** Register a normal route (non-lazy workers, after ready) */
  | { type: 'AddRoute'; def: WorkerDef }
  /** Update route in-place (remove interceptor middleware after lazy activation) */
  | { type: 'UpdateRoute'; def: WorkerDef }
  | { type: 'RemoveRoute'; routeId: string }
  | { type: 'UnregisterInterceptor'; key: string }
  | { type: 'Dispatch'; event: AppEvent }
  | { type: 'Log'; level: 'info' | 'warn' | 'error'; message: string }
