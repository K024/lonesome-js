import 'zx/globals'

import { parseArgs } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

type SetupRuntime = {
  suiteInfo: {
    requested: {
      suite?: string
      upstream?: string
      route?: string
      payload?: string
    }
    resolved: {
      suite: string
      upstream: string
      route: string
      payload: string
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
      kind: string
      endpoint: string
    }
  }
  runtime: {
    host: string
    port: number
    path: string
    method: string
  }
}

type CliOptions = {
  suite?: string
  upstream?: string
  route?: string
  payload?: string
  vus?: string
  duration?: string
  k6Script?: string
  threads?: string
  workSteal?: string
  help?: boolean
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage:',
      '  tsx bench/index.ts run [options]',
      '  tsx bench/index.ts list-suites',
      '',
      'Commands:',
      '  run           Start setup.ts, run k6, then cleanup (default)',
      '  list-suites   Print available benchmark suites',
      '',
      'Options:',
      '  --suite <name>         Use predefined suite (e.g. tcp_simple_tiny)',
      '  --upstream <kind>      tcp | unix | virtual_js | respond',
      '  --route <mode>         simple | many',
      '  --payload <kind>       tiny_hello | medium_json',
      '  --vus <n>              k6 virtual users (default 50)',
      '  --duration <dur>       k6 duration (default 20s)',
      '  --k6-script <path>     k6 script path (default bench/k6/http-get.js)',
      '  --threads <n>          startup.threads (default min(os_threads/2,4))',
      '  --work-steal <bool>    startup.workStealing true|false (default false)',
      '  -h, --help             Show this help',
    ].join('\n') + '\n',
  )
}

function buildSetupArgs(options: CliOptions): string[] {
  const args = ['tsx', 'bench/setup.ts', 'start']
  if (options.suite) args.push('--suite', options.suite)
  if (options.upstream) args.push('--upstream', options.upstream)
  if (options.route) args.push('--route', options.route)
  if (options.payload) args.push('--payload', options.payload)
  if (options.threads) args.push('--threads', options.threads)
  if (options.workSteal) args.push('--work-steal', options.workSteal)
  return args
}

function waitForSetupRuntime(setupProc: ReturnType<typeof $.spawn>): Promise<SetupRuntime> {
  return new Promise((resolveRuntime, reject) => {
    if (!setupProc.stdout) {
      reject(new Error('setup process has no stdout stream'))
      return
    }

    const rl = createInterface({ input: setupProc.stdout })
    let settled = false

    setupProc.stderr?.on('data', (chunk: Buffer | string) => {
      process.stderr.write(chunk)
    })

    rl.on('line', (line) => {
      if (settled) return
      const text = line.trim()
      if (!text) return

      try {
        const parsed = JSON.parse(text) as SetupRuntime
        if (!parsed?.runtime?.host || !parsed?.runtime?.port || !parsed?.runtime?.path) {
          throw new Error('setup runtime json missing required fields')
        }
        settled = true
        rl.close()
        resolveRuntime(parsed)
      } catch {
        process.stderr.write(`${line}\n`)
      }
    })

    setupProc.on('close', (code) => {
      if (!settled) {
        reject(new Error(`setup process exited before runtime was ready (code=${code ?? 'null'})`))
      }
    })
  })
}

async function stopSetup(setupProc: ReturnType<typeof $.spawn>): Promise<void> {
  if (setupProc.killed) return
  setupProc.kill('SIGINT')
  await new Promise<void>((resolveDone) => {
    setupProc.once('close', () => resolveDone())
  })
}

async function runBench(options: CliOptions): Promise<void> {
  const k6Script = options.k6Script ?? 'bench/k6/http-get.js'
  const setupProc = $.spawn('npx', buildSetupArgs(options), {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const runtime = await waitForSetupRuntime(setupProc)

  process.stdout.write(
    [
      'Bench setup:',
      `  requested: suite=${runtime.suiteInfo.requested.suite ?? '-'} upstream=${runtime.suiteInfo.requested.upstream ?? '-'} route=${runtime.suiteInfo.requested.route ?? '-'} payload=${runtime.suiteInfo.requested.payload ?? '-'}`,
      `  resolved: suite=${runtime.suiteInfo.resolved.suite} upstream=${runtime.suiteInfo.resolved.upstream} route=${runtime.suiteInfo.resolved.route} payload=${runtime.suiteInfo.resolved.payload}`,
      `  startup: threads=${runtime.suiteInfo.startup.threads} work-steal=${runtime.suiteInfo.startup.workSteal} os-threads=${runtime.suiteInfo.startup.osThreads}`,
      `  target: rule=${runtime.suiteInfo.target.routeRule} path=${runtime.suiteInfo.target.path} routes=${runtime.suiteInfo.target.routeCount}`,
      `  upstream: kind=${runtime.suiteInfo.upstream.kind} endpoint=${runtime.suiteInfo.upstream.endpoint}`,
      `  payload: content-type=${runtime.suiteInfo.payload.contentType} bytes=${runtime.suiteInfo.payload.bytes}`,
      `  runtime: http://${runtime.runtime.host}:${runtime.runtime.port}${runtime.runtime.path}`,
    ].join('\n') + '\n',
  )

  try {
    await $({
      env: {
        ...process.env,
        BENCH_HOST: runtime.runtime.host,
        BENCH_PORT: String(runtime.runtime.port),
        BENCH_PATH: runtime.runtime.path,
        K6_VUS: options.vus ?? process.env.K6_VUS ?? '50',
        K6_DURATION: options.duration ?? process.env.K6_DURATION ?? '20s',
      },
      stdio: 'inherit',
    })`k6 run ${k6Script}`
  } finally {
    await stopSetup(setupProc)
  }
}

async function listSuitesViaSetup(): Promise<void> {
  const result = await $`npx tsx bench/setup.ts list-suites`
  process.stdout.write(result.stdout)
}

async function main(): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  cd(resolve(__dirname, '..'))

  const parsed = parseArgs({
    options: {
      suite: { type: 'string' },
      upstream: { type: 'string' },
      route: { type: 'string' },
      payload: { type: 'string' },
      threads: { type: 'string' },
      'work-steal': { type: 'string' },
      vus: { type: 'string' },
      duration: { type: 'string' },
      'k6-script': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  })

  const cmd = parsed.positionals[0] ?? 'run'
  const options: CliOptions = {
    suite: parsed.values.suite,
    upstream: parsed.values.upstream,
    route: parsed.values.route,
    payload: parsed.values.payload,
    threads: parsed.values.threads,
    workSteal: parsed.values['work-steal'],
    vus: parsed.values.vus,
    duration: parsed.values.duration,
    k6Script: parsed.values['k6-script'],
    help: parsed.values.help,
  }

  if (options.help) {
    printHelp()
    return
  }

  if (cmd === 'list-suites') {
    await listSuitesViaSetup()
    return
  }

  if (cmd !== 'run') {
    throw new Error(`Unsupported command '${cmd}'. Use 'run' or 'list-suites'.`)
  }

  await runBench(options)
}

void main()
