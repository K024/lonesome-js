export interface FunctionPermissions {
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

export interface RouteMatcher {
  rule: string
  priority?: number
}

export interface Middleware {
  type: string
  config: unknown
}

export interface LoadBalancer {
  algorithm?: 'round_robin' | 'rr' | 'consistent_hash' | 'consistent' | 'ch'
  maxIterations?: number
  hashKeyRule?: string
}

export interface ListenerConfig {
  kind: 'tcp' | 'tls' | 'unix'
  addr: string
  certPath?: string
  keyPath?: string
}

export interface FunctionDef {
  name: string
  handler: string
  handlerHash: string
  matcher: RouteMatcher
  middlewares?: Middleware[]
  permissions?: FunctionPermissions
  env?: Record<string, string>
  replicas?: number
  lazy?: boolean
  timeoutMs?: number
  addresses?: WorkerAddress[]
}

export interface AppConfig {
  listeners: ListenerConfig[]
  threads?: number
  workStealing?: boolean
  workerTransport: WorkerTransportConfig
  loadBalancer?: LoadBalancer
  functionsDir: string
  admin?: {
    listen?: string
    token?: string
    staticDir?: string
  }
  functions: FunctionDef[]
}

export interface WorkerHandle {
  worker: Worker
  def: FunctionDef
  generation: number
  replica: number
}
