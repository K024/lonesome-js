import type {
  AppConfig,
  WorkerAddress,
  WorkerDef,
  WorkerPermissions,
  WorkerTransportConfig,
} from './types.ts'

const DEFAULT_LOOPBACK_HOST = '127.0.0.1'
const DEFAULT_UNIX_DIR = Deno.env.get('TMPDIR') ?? '/tmp'
const DEFAULT_UNIX_PREFIX = 'ls-'
const MAX_UNIX_SOCKET_PATH_LENGTH = 103
const DEFAULT_START_PORT = 19_000
const DEFAULT_MAX_PORT_ATTEMPTS = 1_000

type Assignment = { signature: string; address: WorkerAddress }

type PermissionList = Array<string | URL>
type PermissionValue = 'inherit' | boolean | PermissionList

let loopbackNextPort = DEFAULT_START_PORT
const assigned = new Map<string, Assignment>()
const loopbackReservations: Deno.Listener[] = []

export async function materializeConfig(config: AppConfig): Promise<AppConfig> {
  const workerTransport = config.workerTransport ?? { kind: 'loopback' }
  const signature = transportSignature(workerTransport)
  const activeNames = new Set(config.workers.map(({ name }) => name))

  pruneRemovedAssignments(activeNames)

  const workers: WorkerDef[] = []
  for (const rawWorker of config.workers) {
    const worker = normalizeWorker(rawWorker)
    const addresses = await addressesFor(
      worker.name,
      worker.replicas ?? 1,
      workerTransport,
      signature,
    )
    workers.push(withWorkerRuntime(worker, addresses))
  }

  pruneExcessReplicaAssignments(workers)

  releaseLoopbackReservations()

  return { ...config, workerTransport, workers }
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

    const address = await allocateWorkerAddress(key, transport)
    assigned.set(key, { signature, address })
    addresses.push(address)
  }
  return addresses
}

function pruneRemovedAssignments(activeNames: Set<string>): void {
  for (const key of assigned.keys()) {
    const name = key.split('#', 1)[0]
    if (!activeNames.has(name)) assigned.delete(key)
  }
}

function pruneExcessReplicaAssignments(workers: WorkerDef[]): void {
  const replicaCounts = new Map(
    workers.map((worker) => [worker.name, worker.replicas ?? 1]),
  )

  for (const key of assigned.keys()) {
    const [name, replica] = parseInstanceAssignmentKey(key)
    const replicas = replicaCounts.get(name)
    if (replicas !== undefined && replica >= replicas) assigned.delete(key)
  }
}

function normalizeWorker(worker: WorkerDef): WorkerDef {
  const replicas = Math.max(1, Math.floor(worker.replicas ?? 1))
  const lazyForcedOff = replicas > 1 && worker.lazy === true
  return {
    ...worker,
    replicas,
    lazy: lazyForcedOff ? false : worker.lazy,
    lazyForcedOff,
  }
}

function withWorkerRuntime(
  worker: WorkerDef,
  addresses: WorkerAddress[],
): WorkerDef {
  const address = addresses[0]
  return {
    ...worker,
    address,
    addresses,
    permissions: appendAddressPermissions(worker.permissions, addresses),
  }
}

async function allocateWorkerAddress(
  name: string,
  transport: WorkerTransportConfig,
): Promise<WorkerAddress> {
  if (transport.kind === 'unix') {
    const dir = transport.dir ?? DEFAULT_UNIX_DIR
    await ensureExistingDirectory(dir)

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
      // ok: reservation may already be closed.
    }
  }
}

function appendAddressPermissions(
  permissions: WorkerPermissions | undefined,
  addresses: WorkerAddress[],
): WorkerPermissions {
  const next: WorkerPermissions = { ...(permissions ?? {}) }

  for (const address of addresses) {
    if (address.kind === 'loopback') {
      next.net = appendPermissionEntry(
        next.net,
        `${address.hostname}:${address.port}`,
      ) as WorkerPermissions['net']
    } else {
      // Deno Unix sockets need read permission for connecting and write permission for serving/removing.
      next.read = appendPermissionEntry(
        next.read,
        address.path,
      ) as WorkerPermissions['read']
      next.write = appendPermissionEntry(
        next.write,
        address.path,
      ) as WorkerPermissions['write']
    }
  }

  return next
}

function appendPermissionEntry<T extends string | URL>(
  value: PermissionValue | undefined,
  entry: T,
): PermissionValue {
  if (value === true || value === 'inherit') return value
  if (value === false || value === undefined) return [entry]
  return hasPermissionEntry(value, entry) ? value : [...value, entry]
}

function hasPermissionEntry(
  values: PermissionList,
  entry: string | URL,
): boolean {
  return values.some((value) => String(value) === String(entry))
}

async function ensureExistingDirectory(path: string): Promise<void> {
  let info: Deno.FileInfo
  try {
    info = await Deno.stat(path)
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(`unix socket dir does not exist: ${path}`)
    }
    throw err
  }

  if (!info.isDirectory) {
    throw new Error(`unix socket dir is not a directory: ${path}`)
  }
}

async function removeIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path)
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err
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

function shortRandomId(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 12)
}

function instanceAssignmentKey(name: string, replica: number): string {
  return `${name}#${replica}`
}

function parseInstanceAssignmentKey(key: string): [string, number] {
  const idx = key.lastIndexOf('#')
  if (idx < 0) return [key, 0]
  return [key.slice(0, idx), Number(key.slice(idx + 1))]
}

function trimTrailingSlash(path: string): string {
  return path.replace(/\/$/, '')
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_') || 'worker'
}

function isAddrInUse(err: unknown): boolean {
  return err instanceof Deno.errors.AddrInUse ||
    (err instanceof Error && err.message.includes('Address already in use'))
}

function transportSignature(transport: WorkerTransportConfig): string {
  return JSON.stringify(transport)
}
