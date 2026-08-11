import { parse } from 'jsr:@std/yaml@1'
import { LonesomeServer, type RouteConfig } from 'npm:lonesome-js@0.2'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export { join }
import type {
  AppConfig,
  FunctionDef,
  FunctionPermissions,
  ListenerConfig,
  LoadBalancer,
  WorkerAddress,
  WorkerTransportConfig,
} from './types.ts'
import { routeIdFor, upstreamsFor } from './worker-route.ts'

const DEFAULT_UNIX_PREFIX = 'fn-'
const MAX_UNIX_SOCKET_PATH_LENGTH = 103
const DEFAULT_LOOPBACK_HOST = '127.0.0.1'
const DEFAULT_START_PORT = 19_000
const DEFAULT_MAX_PORT_ATTEMPTS = 1_000
const HANDLER_CANDIDATES = ['handler.ts', 'handler.js', 'index.ts', 'index.js']
const FUNCTION_CONFIG_CANDIDATES = ['config.yml', 'config.yaml']

// Panel build output lives next to the server code (repo root), not cwd.
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

export interface ConfigLoadOptions {
  cwd: string
  configPath: string
}

interface RawConfig {
  listen?: string
  listeners?: ListenerConfig[]
  threads?: number
  workStealing?: boolean
  workerTransport?: WorkerTransportConfig
  loadBalancer?: LoadBalancer
  functionsDir?: string
  admin?: { listen?: string; token?: string; staticDir?: string }
}

interface RawFunction {
  name: string
  dir: string
  handler: string
  handlerHash: string
  matcher: { rule: string; priority?: number }
  middlewares?: Array<{ type: string; config: unknown }>
  permissions?: FunctionPermissions
  env?: Record<string, string>
  replicas?: number
  lazy?: boolean
  timeoutMs?: number
}

type Assignment = { signature: string; address: WorkerAddress }

let loopbackNextPort = DEFAULT_START_PORT
const assigned = new Map<string, Assignment>()
const loopbackReservations: Deno.Listener[] = []

export async function loadConfig(opts: ConfigLoadOptions): Promise<AppConfig> {
  const raw = parse(await Deno.readTextFile(opts.configPath)) as RawConfig
  if (!raw || typeof raw !== 'object') {
    throw new Error('config.yaml is empty or not an object')
  }

  const functionsDir = abs(opts.cwd, raw.functionsDir ?? 'functions')
  await requireExistingDirectory(functionsDir, 'functions dir')

  const workerTransport: WorkerTransportConfig = raw.workerTransport ?? {
    kind: 'unix',
    dir: join(opts.cwd, 'data', 'sockets'),
    prefix: DEFAULT_UNIX_PREFIX,
  }
  if (workerTransport.kind === 'unix') {
    workerTransport.dir = workerTransport.dir
      ? abs(opts.cwd, workerTransport.dir)
      : join(opts.cwd, 'data', 'sockets')
    await ensureDirectory(workerTransport.dir)
  }

  const signature = JSON.stringify(workerTransport)
  const rawFunctions = await scanFunctions(functionsDir)

  const activeNames = new Set(rawFunctions.map((fn) => fn.name))
  pruneRemovedAssignments(activeNames)
  pruneExcessReplicaAssignments(rawFunctions)

  const functions: FunctionDef[] = []
  for (const rawFn of rawFunctions) {
    const replicas = normalizeReplicas(rawFn.replicas)
    const addresses = await addressesFor(
      rawFn.name,
      replicas,
      workerTransport,
      signature,
    )
    functions.push(
      materializeFunction(rawFn, replicas, addresses, functionsDir),
    )
  }

  releaseLoopbackReservations()

  const loadBalancer = raw.loadBalancer ?? { algorithm: 'round_robin' }
  validateFunctionRoutes(functions, loadBalancer)

  return {
    listeners: raw.listeners ??
      (raw.listen ? [{ kind: 'tcp', addr: raw.listen }] : []),
    threads: raw.threads,
    workStealing: raw.workStealing,
    workerTransport,
    loadBalancer,
    functionsDir,
    admin: raw.admin
      ? {
        ...raw.admin,
        staticDir: raw.admin.staticDir
          ? abs(REPO_ROOT, raw.admin.staticDir)
          : undefined,
      }
      : undefined,
    functions,
  }
}

async function scanFunctions(functionsDir: string): Promise<RawFunction[]> {
  const out: RawFunction[] = []
  for await (const entry of Deno.readDir(functionsDir)) {
    if (!entry.isDirectory || entry.name.startsWith('.')) continue
    try {
      out.push(await readFunctionDir(functionsDir, entry.name))
    } catch (err) {
      console.error(`[ERROR] skip function "${entry.name}": ${err}`)
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

async function readFunctionDir(
  functionsDir: string,
  name: string,
): Promise<RawFunction> {
  const dir = join(functionsDir, name)
  const configPath = await firstExisting(dir, FUNCTION_CONFIG_CANDIDATES) ??
    join(dir, 'config.yml')
  let fnConfig: Partial<RawFunction> = {}
  try {
    const parsed = parse(await Deno.readTextFile(configPath))
    if (parsed && typeof parsed === 'object') {
      fnConfig = parsed as Partial<RawFunction>
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err
  }

  const handler = fnConfig.handler
    ? resolvePath(dir, fnConfig.handler)
    : await firstExisting(dir, HANDLER_CANDIDATES)
  if (!handler) {
    throw new Error(
      `no handler file found in ${dir} (looked for ${
        HANDLER_CANDIDATES.join(', ')
      })`,
    )
  }

  const handlerHash = await fileHash(handler)
  const replicas = normalizeReplicas(fnConfig.replicas)
  const lazy = replicas > 1 && fnConfig.lazy === true
    ? false
    : fnConfig.lazy ?? false

  return {
    name,
    dir,
    handler,
    handlerHash,
    matcher: fnConfig.matcher ??
      { rule: `PathPrefix('/${name}')`, priority: 50 },
    middlewares: fnConfig.middlewares,
    permissions: fnConfig.permissions,
    env: fnConfig.env,
    replicas,
    lazy,
    timeoutMs: fnConfig.timeoutMs,
  }
}

function materializeFunction(
  rawFn: RawFunction,
  replicas: number,
  addresses: WorkerAddress[],
  functionsDir: string,
): FunctionDef {
  return {
    name: rawFn.name,
    handler: rawFn.handler,
    handlerHash: rawFn.handlerHash,
    matcher: rawFn.matcher,
    middlewares: rawFn.middlewares,
    env: rawFn.env,
    replicas,
    lazy: rawFn.lazy,
    timeoutMs: rawFn.timeoutMs,
    addresses,
    permissions: withRuntimePermissions(rawFn, addresses, functionsDir),
  }
}

function withRuntimePermissions(
  rawFn: RawFunction,
  addresses: WorkerAddress[],
  functionsDir: string,
): FunctionPermissions {
  const perms: FunctionPermissions = { ...(rawFn.permissions ?? {}) }
  if (perms.import === undefined) perms.import = true
  appendPermissionEntry(perms, 'read', functionsDir)

  for (const address of addresses) {
    if (address.kind === 'loopback') {
      appendPermissionEntry(
        perms,
        'net',
        `${address.hostname}:${address.port}`,
      )
    } else {
      appendPermissionEntry(perms, 'net', `unix:${address.path}`)
      appendPermissionEntry(perms, 'read', address.path)
      appendPermissionEntry(perms, 'write', address.path)
    }
  }

  if (rawFn.env) {
    const keys = Object.keys(rawFn.env)
    const value = perms.env
    if (value === undefined || value === false) {
      perms.env = keys
    } else if (Array.isArray(value)) {
      for (const key of keys) {
        if (!value.includes(key)) value.push(key)
      }
    }
  }

  return perms
}

function appendPermissionEntry(
  perms: FunctionPermissions,
  key: keyof FunctionPermissions,
  entry: string,
): void {
  const current = perms[key]
  if (current === true || current === 'inherit') return
  const list = (current === undefined || current === false)
    ? []
    : (current as Array<string | URL>).map(String)
  if (!list.includes(entry)) list.push(entry)
  perms[key] = list
}

async function addressesFor(
  name: string,
  replicas: number,
  transport: WorkerTransportConfig,
  signature: string,
): Promise<WorkerAddress[]> {
  const addresses: WorkerAddress[] = []
  for (let replica = 0; replica < replicas; replica++) {
    const key = instanceAssignmentKey(name, replica)
    const previous = assigned.get(key)
    if (previous?.signature === signature) {
      addresses.push(previous.address)
      continue
    }
    const address = await allocateWorkerAddress(name, transport)
    assigned.set(key, { signature, address })
    addresses.push(address)
  }
  return addresses
}

async function allocateWorkerAddress(
  name: string,
  transport: WorkerTransportConfig,
): Promise<WorkerAddress> {
  if (transport.kind === 'unix') {
    const dir = transport.dir!
    await ensureDirectory(dir)
    const prefix = transport.prefix ?? DEFAULT_UNIX_PREFIX
    const path = unixSocketPath(dir, prefix, name)
    await removeIfExists(path)
    return { kind: 'unix', path }
  }

  const hostname = transport.hostname ?? DEFAULT_LOOPBACK_HOST
  const port = allocateLoopbackPort(
    hostname,
    transport.startPort ?? DEFAULT_START_PORT,
    transport.maxPortAttempts ?? DEFAULT_MAX_PORT_ATTEMPTS,
  )
  return { kind: 'loopback', hostname, port }
}

function allocateLoopbackPort(
  hostname: string,
  startPort: number,
  maxAttempts: number,
): number {
  if (loopbackNextPort < startPort) loopbackNextPort = startPort

  for (let i = 0; i < maxAttempts; i++) {
    const port = loopbackNextPort++
    let listener: Deno.Listener | null = null
    try {
      listener = Deno.listen({ hostname, port })
      loopbackReservations.push(listener)
      listener = null
      return port
    } catch (err) {
      if (isAddrInUse(err)) continue
      throw err
    } finally {
      listener?.close()
    }
  }

  throw new Error(`failed to allocate a free loopback port on ${hostname}`)
}

function releaseLoopbackReservations(): void {
  for (const listener of loopbackReservations.splice(0)) {
    try {
      listener.close()
    } catch {
      // already closed
    }
  }
}

function unixSocketPath(dir: string, prefix: string, name: string): string {
  const base = `${trimTrailingSlash(dir)}/${prefix}`
  const suffix = `-${shortRandomId()}.sock`
  const maxNameLength = MAX_UNIX_SOCKET_PATH_LENGTH - base.length -
    suffix.length
  if (maxNameLength < 1) {
    throw new Error(
      `unix socket dir/prefix too long: ${base} (must leave room within ${MAX_UNIX_SOCKET_PATH_LENGTH} chars)`,
    )
  }
  return `${base}${sanitizeName(name).slice(0, maxNameLength)}${suffix}`
}

function pruneRemovedAssignments(activeNames: Set<string>): void {
  for (const key of assigned.keys()) {
    if (!activeNames.has(key.split('#', 1)[0])) assigned.delete(key)
  }
}

function pruneExcessReplicaAssignments(functions: RawFunction[]): void {
  const replicaCounts = new Map(
    functions.map((fn) => [fn.name, normalizeReplicas(fn.replicas)]),
  )
  for (const key of assigned.keys()) {
    const idx = key.lastIndexOf('#')
    const name = idx < 0 ? key : key.slice(0, idx)
    const replica = idx < 0 ? 0 : Number(key.slice(idx + 1))
    const count = replicaCounts.get(name)
    if (count !== undefined && replica >= count) assigned.delete(key)
  }
}

async function requireExistingDirectory(
  path: string,
  label: string,
): Promise<void> {
  let info: Deno.FileInfo
  try {
    info = await Deno.stat(path)
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(`${label} does not exist: ${path}`)
    }
    throw err
  }
  if (!info.isDirectory) {
    throw new Error(`${label} is not a directory: ${path}`)
  }
}

async function ensureDirectory(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true })
}

async function removeIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path)
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err
  }
}

async function fileHash(path: string): Promise<string> {
  const data = await Deno.readFile(path)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

let routeValidator: LonesomeServer | null = null

// Validate every function's route config (matcher CEL, middlewares, upstreams,
// load balancer) up front, so a broken function never reaches reconcile and
// ends up "ready but unrouted".
function validateFunctionRoutes(
  functions: FunctionDef[],
  loadBalancer?: LoadBalancer,
): void {
  routeValidator ??= new LonesomeServer()
  for (const def of functions) {
    try {
      routeValidator.validate(routeConfigFor(def, loadBalancer))
    } catch (err) {
      throw new Error(
        `function "${def.name}" has an invalid route config: ${err}`,
      )
    }
  }
}

function routeConfigFor(
  def: FunctionDef,
  loadBalancer?: LoadBalancer,
): RouteConfig {
  return {
    id: routeIdFor(def.name),
    matcher: def.matcher,
    middlewares: def.middlewares ?? [],
    upstreams: upstreamsFor(def),
    loadBalancer,
  }
}

async function firstExisting(
  dir: string,
  candidates: string[],
): Promise<string | null> {
  for (const candidate of candidates) {
    const path = join(dir, candidate)
    try {
      await Deno.stat(path)
      return path
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err
    }
  }
  return null
}

function resolvePath(baseDir: string, path: string): string {
  return path.startsWith('/') ? path : join(baseDir, path)
}

export function abs(baseDir: string, path: string): string {
  return path.startsWith('/') ? path : resolve(baseDir, path)
}

function trimTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '')
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_') || 'function'
}

function shortRandomId(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 12)
}

function instanceAssignmentKey(name: string, replica: number): string {
  return `${name}#${replica}`
}

function normalizeReplicas(replicas?: number): number {
  return Math.max(1, Math.floor(replicas ?? 1))
}

function isAddrInUse(err: unknown): boolean {
  return err instanceof Deno.errors.AddrInUse ||
    (err instanceof Error && err.message.includes('Address already in use'))
}

export function watchPaths(
  paths: string[],
  onChange: () => void,
): Deno.FsWatcher {
  const watcher = Deno.watchFs(paths)
  void (async () => {
    for await (const event of watcher) {
      if (
        event.kind === 'modify' || event.kind === 'create' ||
        event.kind === 'remove'
      ) {
        onChange()
      }
    }
  })()
  return watcher
}
