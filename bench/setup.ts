import { mkdtemp } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { availableParallelism, cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { LonesomeServer } from '../dist/index.js'
import type { RouteConfig, StartupConfig, UpstreamConfig } from '../dist/index.js'
import { pickFreePort, sleep } from '../e2e-test/helpers/proxy.js'
import { nextRouteId, virtualUpstream } from '../e2e-test/helpers/routes.js'
import { createDynamicUpstream } from '../e2e-test/helpers/upstream.js'
import { startVirtualUpstream } from '../e2e-test/helpers/virtual.js'
import { getPayload, type PayloadPreset } from './helpers/payload.js'
import type {
  BenchRuntimeConfig,
  BenchSetup,
  PayloadSelection,
  RouteSelection,
  UpstreamSelection,
} from './helpers/types.js'
import { createUnixUpstream } from './helpers/unix_upstream.js'

type ActiveResource = {
  close: () => Promise<void>
}

export type BenchStartupOptions = {
  threads: number
  workSteal: boolean
}

export type BenchSuiteInfo = {
  requested: {
    suite?: string
    upstream?: string
    route?: string
    payload?: string
    threads?: string
    workSteal?: string
  }
  resolved: {
    suite: string
    upstream: UpstreamSelection
    route: RouteSelection
    payload: PayloadSelection
  }
  startup: {
    threads: number
    workSteal: boolean
    osThreads: number
  }
  target: {
    routeRule: string
    path: string
    routeCount: number
  }
  payload: {
    contentType: string
    bytes: number
  }
  upstream: {
    kind: UpstreamSelection
    endpoint: string
  }
}

const SUITES: Record<string, BenchSetup> = {
  tcp_simple_tiny: { upstream: 'tcp', route: 'simple', payload: 'tiny_hello' },
  tcp_many_tiny: { upstream: 'tcp', route: 'many', payload: 'tiny_hello' },
  tcp_simple_medium: { upstream: 'tcp', route: 'simple', payload: 'medium_json' },
  unix_simple_tiny: { upstream: 'unix', route: 'simple', payload: 'tiny_hello' },
  vjs_simple_tiny: { upstream: 'virtual_js', route: 'simple', payload: 'tiny_hello' },
  respond_simple_tiny: { upstream: 'respond', route: 'simple', payload: 'tiny_hello' },
}

const SUPPORTED_UPSTREAM: UpstreamSelection[] = ['tcp', 'unix', 'virtual_js', 'respond']
const SUPPORTED_ROUTE: RouteSelection[] = ['simple', 'many']
const SUPPORTED_PAYLOAD: PayloadSelection[] = ['tiny_hello', 'medium_json']

function detectOsThreads(): number {
  try {
    return availableParallelism()
  } catch {
    return cpus().length
  }
}

function defaultThreadsFromOs(osThreads: number): number {
  return Math.max(1, Math.min(Math.floor(osThreads / 2), 4))
}

function assertOneOf<T extends string>(value: string, supported: T[], argName: string): T {
  if (!supported.includes(value as T)) {
    throw new Error(`Unsupported ${argName}=${value}. Expected one of: ${supported.join(', ')}`)
  }
  return value as T
}

function parseBool(value: string, argName: string): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`Unsupported ${argName}=${value}. Expected true or false`)
}

export function listSuites(): string[] {
  return Object.keys(SUITES)
}

export function resolveSetup(input: {
  suite?: string
  upstream?: string
  route?: string
  payload?: string
}): BenchSetup {
  if (input.suite) {
    const setup = SUITES[input.suite]
    if (!setup) {
      throw new Error(`Unsupported suite '${input.suite}'. Available suites: ${listSuites().join(', ')}`)
    }
    return setup
  }

  const upstream = assertOneOf(input.upstream ?? 'tcp', SUPPORTED_UPSTREAM, 'upstream')
  const route = assertOneOf(input.route ?? 'simple', SUPPORTED_ROUTE, 'route')
  const payload = assertOneOf(input.payload ?? 'tiny_hello', SUPPORTED_PAYLOAD, 'payload')
  return { upstream, route, payload }
}

export function resolveStartupOptions(input: {
  threads?: string
  workSteal?: string
}): BenchStartupOptions {
  const osThreads = detectOsThreads()
  const defaultThreads = defaultThreadsFromOs(osThreads)

  const threads = input.threads ? Number(input.threads) : defaultThreads
  if (!Number.isFinite(threads) || !Number.isInteger(threads) || threads <= 0) {
    throw new Error(`Invalid threads=${input.threads ?? ''}. Expected a positive integer.`)
  }

  const workSteal = input.workSteal ? parseBool(input.workSteal, 'work-steal') : threads <= 1

  return {
    threads,
    workSteal,
  }
}

function routeRule(routeMode: RouteSelection): string {
  return routeMode === 'simple' ? "Path('/bench/target')" : "Path('/bench/r19/target')"
}

function routePath(routeMode: RouteSelection): string {
  return routeMode === 'simple' ? '/bench/target' : '/bench/r19/target'
}

function makeResponseHandler(payloadPreset: PayloadPreset) {
  const payload = getPayload(payloadPreset)
  return (_req: IncomingMessage, res: ServerResponse): void => {
    res.setHeader('content-type', payload.contentType)
    res.end(payload.body)
  }
}

function buildRoute(id: string, setup: BenchSetup, upstreams: UpstreamConfig[]): RouteConfig {
  const payload = getPayload(setup.payload)
  const middlewares = setup.upstream === 'respond'
    ? [{ type: 'respond', config: { status: 200, body: payload.body, content_type: payload.contentType } }]
    : []

  return {
    id,
    matcher: { rule: routeRule(setup.route), priority: 100 },
    middlewares,
    upstreams,
  }
}

function buildNoiseRoutes(server: LonesomeServer, setup: BenchSetup, upstreams: UpstreamConfig[]): string[] {
  if (setup.route !== 'many') return []

  const ids: string[] = []
  for (let i = 0; i < 19; i++) {
    const id = nextRouteId(`bench-noise-${i}`)
    server.addOrUpdate({
      id,
      matcher: { rule: `Path('/bench/r${i}/target')`, priority: 100 - i },
      middlewares: [],
      upstreams,
    })
    ids.push(id)
  }
  return ids
}

async function setupTcp(setup: BenchSetup): Promise<{ upstreams: UpstreamConfig[]; resources: ActiveResource[] }> {
  const upstream = createDynamicUpstream()
  upstream.setHandler(makeResponseHandler(setup.payload))
  await upstream.start()

  return {
    upstreams: [{ kind: 'tcp', address: `127.0.0.1:${upstream.port}`, tls: false, sni: '', weight: 1 }],
    resources: [{ close: async () => upstream.stop() }],
  }
}

async function setupUnix(setup: BenchSetup): Promise<{ upstreams: UpstreamConfig[]; resources: ActiveResource[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'lonesome-bench-'))
  const socketPath = join(dir, 'bench.sock')
  const upstream = createUnixUpstream(socketPath, makeResponseHandler(setup.payload))
  await upstream.start()

  return {
    upstreams: [{ kind: 'unix', address: socketPath, tls: false, sni: '', weight: 1 }],
    resources: [{ close: async () => upstream.stop() }],
  }
}

async function setupVirtualJs(setup: BenchSetup): Promise<{ upstreams: UpstreamConfig[]; resources: ActiveResource[] }> {
  const key = `bench-vjs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const vjs = startVirtualUpstream(key, makeResponseHandler(setup.payload))

  return {
    upstreams: virtualUpstream(key),
    resources: [{ close: async () => vjs.stop() }],
  }
}

async function setupRespond(): Promise<{ upstreams: UpstreamConfig[]; resources: ActiveResource[] }> {
  const sink = createHttpServer((_req, res) => res.end('unreachable'))
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve))
  const port = (sink.address() as { port: number }).port

  return {
    upstreams: [{ kind: 'tcp', address: `127.0.0.1:${port}`, tls: false, sni: '', weight: 1 }],
    resources: [{ close: async () => new Promise<void>((resolve, reject) => sink.close((err) => (err ? reject(err) : resolve()))) }],
  }
}

export async function startBenchEnvironment(setup: BenchSetup, startup: BenchStartupOptions): Promise<{
  runtime: BenchRuntimeConfig
  upstreamEndpoint: string
  routeCount: number
  shutdown: () => Promise<void>
}> {
  const port = await pickFreePort()
  const server = new LonesomeServer()
  const startupConfig: StartupConfig = {
    listeners: [{ kind: 'tcp', addr: `127.0.0.1:${port}` }],
    threads: startup.threads,
    workStealing: startup.workSteal,
  }
  server.start(startupConfig)
  await sleep(600)

  const resources: ActiveResource[] = []
  const routeIds: string[] = []
  let stopping = false

  const shutdown = async (): Promise<void> => {
    if (stopping) return
    stopping = true

    for (const routeId of routeIds) {
      try {
        server.remove(routeId)
      } catch {
        // best effort
      }
    }

    try {
      server.stop()
    } catch {
      // best effort
    }

    for (const resource of resources.reverse()) {
      try {
        await resource.close()
      } catch {
        // best effort
      }
    }
  }

  try {
    let upstreamSetup: { upstreams: UpstreamConfig[]; resources: ActiveResource[] }
    let upstreamEndpoint = ''
    if (setup.upstream === 'tcp') {
      upstreamSetup = await setupTcp(setup)
      upstreamEndpoint = upstreamSetup.upstreams[0]?.address ?? ''
    } else if (setup.upstream === 'unix') {
      upstreamSetup = await setupUnix(setup)
      upstreamEndpoint = upstreamSetup.upstreams[0]?.address ?? ''
    } else if (setup.upstream === 'virtual_js') {
      upstreamSetup = await setupVirtualJs(setup)
      upstreamEndpoint = upstreamSetup.upstreams[0]?.address ?? ''
    } else {
      upstreamSetup = await setupRespond()
      upstreamEndpoint = `respond-middleware (dummy upstream: ${upstreamSetup.upstreams[0]?.address ?? 'n/a'})`
    }

    resources.push(...upstreamSetup.resources)

    const targetId = nextRouteId('bench-target')
    server.addOrUpdate(buildRoute(targetId, setup, upstreamSetup.upstreams))
    routeIds.push(targetId)

    const noiseIds = buildNoiseRoutes(server, setup, upstreamSetup.upstreams)
    routeIds.push(...noiseIds)

    await sleep(200)

    return {
      runtime: {
        host: '127.0.0.1',
        port,
        path: routePath(setup.route),
        method: 'GET',
      },
      upstreamEndpoint,
      routeCount: routeIds.length,
      shutdown,
    }
  } catch (err) {
    await shutdown()
    throw err
  }
}

function printSetupHelp(): void {
  process.stdout.write(
    [
      'Usage:',
      '  tsx bench/setup.ts start [--suite <name>] [--upstream <kind>] [--route <mode>] [--payload <kind>] [--threads <n>] [--work-steal <bool>]',
      '  tsx bench/setup.ts list-suites',
      '',
      'Options:',
      '  --suite       Predefined suite name',
      '  --upstream    tcp | unix | virtual_js | respond',
      '  --route       simple | many',
      '  --payload     tiny_hello | medium_json',
      '  --threads     startup.threads (default: min(os_threads/2,4))',
      '  --work-steal  startup.workStealing true|false (default: threads <= 1 ? true : false)',
      '  --help        Show this help',
    ].join('\n') + '\n',
  )
}

async function runCli(): Promise<void> {
  const parsed = parseArgs({
    options: {
      suite: { type: 'string' },
      upstream: { type: 'string' },
      route: { type: 'string' },
      payload: { type: 'string' },
      threads: { type: 'string' },
      'work-steal': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  })

  const command = parsed.positionals[0] ?? 'start'

  if (parsed.values.help) {
    printSetupHelp()
    return
  }

  if (command === 'list-suites') {
    for (const suite of listSuites()) {
      process.stdout.write(`${suite}\n`)
    }
    return
  }

  if (command !== 'start') {
    throw new Error(`Unsupported command '${command}'. Use 'start' or 'list-suites'.`)
  }

  const setup = resolveSetup({
    suite: parsed.values.suite,
    upstream: parsed.values.upstream,
    route: parsed.values.route,
    payload: parsed.values.payload,
  })
  const startup = resolveStartupOptions({
    threads: parsed.values.threads,
    workSteal: parsed.values['work-steal'],
  })

  const resolvedSuite = parsed.values.suite ?? 'custom'
  const payload = getPayload(setup.payload)
  const osThreads = detectOsThreads()

  const { runtime, upstreamEndpoint, routeCount, shutdown } = await startBenchEnvironment(setup, startup)
  const suiteInfo: BenchSuiteInfo = {
    requested: {
      suite: parsed.values.suite,
      upstream: parsed.values.upstream,
      route: parsed.values.route,
      payload: parsed.values.payload,
      threads: parsed.values.threads,
      workSteal: parsed.values['work-steal'],
    },
    resolved: {
      suite: resolvedSuite,
      upstream: setup.upstream,
      route: setup.route,
      payload: setup.payload,
    },
    startup: {
      threads: startup.threads,
      workSteal: startup.workSteal,
      osThreads,
    },
    target: {
      routeRule: routeRule(setup.route),
      path: routePath(setup.route),
      routeCount,
    },
    payload: {
      contentType: payload.contentType,
      bytes: Buffer.byteLength(payload.body),
    },
    upstream: {
      kind: setup.upstream,
      endpoint: upstreamEndpoint,
    },
  }
  process.stdout.write(`${JSON.stringify({ suiteInfo, runtime })}\n`)

  let exiting = false
  const exitWithCleanup = (signal: NodeJS.Signals): void => {
    if (exiting) return
    exiting = true
    void shutdown().then(() => {
      process.kill(process.pid, signal)
    })
  }

  process.on('SIGINT', () => exitWithCleanup('SIGINT'))
  process.on('SIGTERM', () => exitWithCleanup('SIGTERM'))

  await new Promise<void>(() => {
    // keep setup process alive until killed by parent controller
  })
}

void runCli()
