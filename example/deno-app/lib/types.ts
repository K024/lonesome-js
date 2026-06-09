/** Deno PermissionOptions — mirrors Deno.PermissionOptions */
export interface WorkerPermissions {
  read?: boolean | string[];
  write?: boolean | string[];
  net?: boolean | string[];
  env?: boolean | string[];
  run?: boolean | string[];
  ffi?: boolean | string[];
  import?: boolean | string[];
  sys?: boolean | string[];
}

export interface WorkerDef {
  name: string;
  /** Entry script. Must default-export: (req: Request) => Response | Promise<Response> */
  main: string;
  /** Internal port the worker binds */
  port: number;
  /** Route matcher — LonesomeServer registers ONE route per worker */
  matcher: { rule: string; priority?: number };
  /** Optional middlewares (applied AFTER the lazy interceptor if lazy=true) */
  middlewares?: Array<{ type: string; config: unknown }>;
  permissions?: WorkerPermissions;
  env?: Record<string, string>;
  /** If true, worker spawns on first request (via interceptor). Default: false. */
  lazy?: boolean;
}

export interface AppConfig {
  listeners: Array<{
    kind: 'tcp' | 'tls' | 'unix';
    addr: string;
    certPath?: string;
    keyPath?: string;
  }>;
  threads?: number;
  workStealing?: boolean;
  workers: WorkerDef[];
}

// ── Reducer ─────────────────────────────────────────────────

export interface WorkerHandle {
  worker: Worker;
  config: WorkerDef;
}

export interface AppState {
  config: AppConfig | null;
  server: unknown | null;
  workers: Map<string, WorkerHandle>;
  /** Worker names that have sent 'ready' */
  readyWorkers: Set<string>;
  /** workerName → routeId */
  workerRoutes: Map<string, string>;
  watcher: Deno.FsWatcher | null;
}

export type AppEvent =
  | { type: 'Init'; configPath: string }
  | { type: 'ConfigLoaded'; config: AppConfig }
  | { type: 'ConfigError'; error: string }
  | { type: 'ConfigChanged'; config: AppConfig }
  /** Fired by the lazy interceptor on first request */
  | { type: 'LazyWorkerRequested'; name: string }
  | { type: 'WorkerReady'; name: string }
  | { type: 'WorkerCrashed'; name: string; reason: string }
  | { type: 'Shutdown' };

export type AppEffect =
  | { type: 'LoadConfig'; path: string }
  | { type: 'WatchConfig'; path: string }
  | { type: 'StartServer'; config: AppConfig }
  | { type: 'StopServer' }
  | { type: 'SpawnWorker'; def: WorkerDef }
  | { type: 'KillWorker'; name: string }
  /** Register the initial route + lazy interceptor (lazy workers only) */
  | { type: 'AddLazyRoute'; def: WorkerDef }
  /** Register a normal route (non-lazy workers, after ready) */
  | { type: 'AddRoute'; def: WorkerDef }
  /** Update route in-place (remove interceptor middleware after lazy activation) */
  | { type: 'UpdateRoute'; def: WorkerDef }
  | { type: 'RemoveRoute'; routeId: string }
  | { type: 'UnregisterInterceptor'; key: string }
  | { type: 'Log'; level: 'info' | 'warn' | 'error'; message: string };
