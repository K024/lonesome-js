import {
  analyzeRule,
  evaluateExpression,
  evaluateRule,
} from 'npm:lonesome-js@0.2'
import { parse } from 'jsr:@std/yaml@1'
import type { Runtime } from './runtime.ts'
import { extname, join, normalize } from 'node:path'

export interface AdminOptions {
  listen: string
  token?: string
  staticDir?: string
}

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
}

export class AdminServer {
  private server: Deno.HttpServer | null = null
  private controller = new AbortController()
  private readonly runtime: Runtime
  private readonly opts: AdminOptions

  constructor(runtime: Runtime, opts: AdminOptions) {
    this.runtime = runtime
    this.opts = opts
  }

  matches(opts: AdminOptions): boolean {
    return this.opts.listen === opts.listen &&
      (this.opts.token ?? '') === (opts.token ?? '') &&
      (this.opts.staticDir ?? '') === (opts.staticDir ?? '')
  }

  start(): void {
    const [hostname, port] = parseListen(this.opts.listen)
    this.server = Deno.serve(
      {
        hostname,
        port,
        signal: this.controller.signal,
        onListen: () => {},
      },
      (req) => this.handle(req),
    )
  }

  async stop(): Promise<void> {
    this.controller.abort()
    if (this.server) {
      try {
        await this.server.shutdown()
      } catch {
        // best-effort
      }
      this.server = null
    }
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname

    if (path === '/admin/healthz') {
      return json({ ok: true })
    }

    // Admin API only; everything else is the static panel.
    if (path.startsWith('/admin/api/')) {
      if (!this.authorized(req)) {
        return json({ error: 'unauthorized' }, 401)
      }

      const segments = path.slice('/admin/api/'.length).split('/').filter(
        Boolean,
      )

      try {
        switch (segments[0]) {
          case 'status':
            return json(this.runtime.snapshot())
          case 'functions':
            return this.handleFunctions(req, segments.slice(1))
          case 'logs':
            return this.handleLogs(url)
          case 'reload':
            if (req.method !== 'POST') return methodNotAllowed()
            this.runtime.reload()
            return json({ ok: true })
          case 'invoke':
            return this.handleInvoke(req)
          case 'diagnostics':
            return this.handleDiagnostics(req, segments.slice(1))
          default:
            return json({ error: 'not found' }, 404)
        }
      } catch (err) {
        return json({ error: String(err) }, 500)
      }
    }

    // Static panel (served on the same management port, no auth).
    return await serveStatic(this.opts.staticDir, url)
  }

  private async handleInvoke(req: Request): Promise<Response> {
    if (req.method !== 'POST') return methodNotAllowed()
    let body: {
      path?: string
      method?: string
      body?: string
      headers?: Record<string, string>
    }
    try {
      body = await req.json()
    } catch {
      return json({ error: 'invalid json body' }, 400)
    }
    if (!body.path) return json({ error: 'path required' }, 400)

    const addr = this.runtime.snapshot().server?.listeners[0]
    if (!addr) return json({ error: 'proxy listener not running' }, 503)

    const method = body.method ?? 'GET'
    const headers = new Headers(body.headers ?? {})
    if (body.body !== undefined) {
      headers.set(
        'content-type',
        headers.get('content-type') ?? 'application/json',
      )
    }
    const upstream = await fetch(`http://${addr}${body.path}`, {
      method,
      headers,
      body: body.body ?? undefined,
    })
    const text = await upstream.text()
    return json({
      status: upstream.status,
      headers: Object.fromEntries(upstream.headers.entries()),
      body: text.slice(0, 16_384),
    })
  }

  private async handleFunctions(
    req: Request,
    rest: string[],
  ): Promise<Response> {
    if (rest.length === 0) {
      if (req.method === 'GET') {
        return json(this.runtime.snapshot().functions)
      }
      return methodNotAllowed()
    }

    const name = rest[0]
    if (!NAME_PATTERN.test(name)) {
      return json({ error: `invalid function name: ${name}` }, 400)
    }

    // Read-only: functions are managed by git (files under functions/).
    if (req.method === 'GET') {
      const detail = await readFunction(this.runtime.functionsDir, name)
      if (!detail) return json({ error: `function not found: ${name}` }, 404)
      return json(detail)
    }

    return methodNotAllowed()
  }

  private handleLogs(url: URL): Response {
    const since = Number(url.searchParams.get('since') ?? 0) || 0
    const source = url.searchParams.get('source') ?? undefined
    return json(
      this.runtime.logs.list({ since: since > 0 ? since : undefined, source }),
    )
  }

  private async handleDiagnostics(
    req: Request,
    rest: string[],
  ): Promise<Response> {
    if (rest[0] !== 'cel' || req.method !== 'POST') {
      return json({ error: 'use POST /admin/api/diagnostics/cel' }, 400)
    }

    let body: {
      mode?: 'rule' | 'expression' | 'analyze'
      input?: string
      request?: {
        method?: string
        path?: string
        headers?: Array<{ name: string; value: string }>
      }
    }
    try {
      body = await req.json()
    } catch {
      return json({ error: 'invalid json body' }, 400)
    }

    const mode = body.mode ?? 'rule'
    const input = body.input ?? ''
    const request = body.request
      ? {
        method: body.request.method ?? 'GET',
        path: body.request.path ?? '/',
        headers: body.request.headers,
      }
      : undefined

    try {
      if (mode === 'expression') {
        return json({ result: evaluateExpression(input, request ?? null) })
      }
      if (mode === 'analyze') {
        return json({ result: analyzeRule(input) })
      }
      return json({
        analyze: analyzeRule(input),
        evaluation: evaluateRule(
          input,
          request ?? { method: 'GET', path: '/' },
        ),
      })
    } catch (err) {
      return json({ error: String(err) }, 400)
    }
  }

  private authorized(req: Request): boolean {
    const token = this.opts.token
    if (!token) return true
    const provided = req.headers.get('x-admin-token') ??
      (req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '')
    return provided === token
  }
}

async function readFunction(
  functionsDir: string,
  name: string,
): Promise<{ config?: Record<string, unknown>; handler?: string } | null> {
  const dir = join(functionsDir, name)
  if (!(await exists(dir))) return null
  const out: { config?: Record<string, unknown>; handler?: string } = {}
  const configPath = await firstExisting(dir, ['config.yml', 'config.yaml'])
  const handlerPath = join(dir, 'handler.ts')
  if (configPath) {
    out.config = parse(await Deno.readTextFile(configPath)) as Record<
      string,
      unknown
    >
  }
  if (await exists(handlerPath)) {
    out.handler = await Deno.readTextFile(handlerPath)
  }
  return out
}

async function firstExisting(
  dir: string,
  candidates: string[],
): Promise<string | null> {
  for (const candidate of candidates) {
    const path = join(dir, candidate)
    if (await exists(path)) return path
  }
  return null
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path)
    return true
  } catch {
    return false
  }
}

async function serveStatic(
  staticDir: string | undefined,
  url: URL,
): Promise<Response> {
  if (!staticDir) return json({ error: 'not found' }, 404)

  let rel = url.pathname
  if (rel === '/' || rel === '') rel = '/index.html'

  const filePath = normalize(join(staticDir, rel))
  if (!filePath.startsWith(staticDir)) {
    return json({ error: 'forbidden' }, 403)
  }

  try {
    const info = await Deno.stat(filePath)
    if (!info.isFile) throw new Error('not a file')
    const data = await Deno.readFile(filePath)
    return new Response(data, {
      headers: {
        'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
      },
    })
  } catch {
    // SPA fallback: serve index.html for unknown routes.
    try {
      const index = await Deno.readFile(join(staticDir, 'index.html'))
      return new Response(index, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    } catch {
      return json({ error: 'not found' }, 404)
    }
  }
}

function parseListen(listen: string): [string, number] {
  const idx = listen.lastIndexOf(':')
  if (idx < 0) return ['127.0.0.1', Number(listen)]
  const host = listen.slice(0, idx) || '127.0.0.1'
  const port = Number(listen.slice(idx + 1))
  return [host, port]
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function methodNotAllowed(): Response {
  return json({ error: 'method not allowed' }, 405)
}
