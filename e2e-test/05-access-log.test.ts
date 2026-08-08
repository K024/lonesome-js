import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startProxy } from './helpers/proxy.js'
import { createDynamicUpstream } from './helpers/upstream.js'
import { nextRouteId, withRoute } from './helpers/routes.js'
import { proxyFetch } from './helpers/request.js'
import type { LonesomeServer } from '../dist/index.js'

let server: LonesomeServer
let proxyPort: number
const upstream = createDynamicUpstream()
let logDir: string

before(async () => {
  logDir = mkdtempSync(join(tmpdir(), 'lonesome-alog-'))
  await upstream.start()
  ;({ server, port: proxyPort } = await startProxy())
})

after(async () => {
  try {
    server?.stop()
  } catch {
    // ok
  }
  await upstream.stop()
  rmSync(logDir, { recursive: true, force: true })
})

const upstreams = () => [{
  kind: 'tcp' as const,
  address: `127.0.0.1:${upstream.port}`,
  tls: false,
  sni: '',
  weight: 1,
}]

/**
 * Access log lines are written by a dedicated async writer task, so poll the
 * file until the expected line appears (or fail after the timeout).
 */
async function waitForFileContent(file: string, match: RegExp, timeoutMs = 2000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let content = ''
  while (Date.now() < deadline) {
    content = readFileSync(file, 'utf8')
    if (match.test(content)) return content
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for access log ${match} in ${file}; got: ${JSON.stringify(content)}`)
}

describe('access_log middleware', () => {
  it('text format appends access lines to the configured file', async () => {
    const file = join(logDir, 'text.log')
    const clean = withRoute(server, {
      id: nextRouteId('alog-text'),
      matcher: { rule: "PathPrefix('/alog/text')", priority: 50 },
      middlewares: [{ type: 'access_log', config: { format: 'text', file } }],
      upstreams: upstreams(),
    })

    const res = await proxyFetch(proxyPort, '/alog/text/item')
    await res.text()
    assert.strictEqual(res.status, 200)

    const content = await waitForFileContent(file, /GET \/alog\/text\/item status=200 latency=\d+ms/)
    assert.ok(content.length > 0)

    clean()
  })

  it('json format appends JSON lines to the configured file', async () => {
    const file = join(logDir, 'json.log')
    const clean = withRoute(server, {
      id: nextRouteId('alog-json'),
      matcher: { rule: "PathPrefix('/alog/json')", priority: 50 },
      middlewares: [{ type: 'access_log', config: { format: 'json', file } }],
      upstreams: upstreams(),
    })

    const res = await proxyFetch(proxyPort, '/alog/json/item')
    await res.text()
    assert.strictEqual(res.status, 200)

    const content = await waitForFileContent(file, /\/alog\/json\/item/)
    const lines = content.trim().split('\n')
    const entry = JSON.parse(lines[lines.length - 1])
    assert.strictEqual(entry.method, 'GET')
    assert.strictEqual(entry.path, '/alog/json/item')
    assert.strictEqual(entry.status, 200)
    assert.ok(entry.latency_ms >= 0)

    clean()
  })

  it('rejects an unknown format at validation', () => {
    assert.throws(
      () => {
        server.validate({
          id: nextRouteId('alog-bad-format'),
          matcher: { rule: "PathPrefix('/alog/bad')", priority: 50 },
          middlewares: [{ type: 'access_log', config: { format: 'xml', file: join(logDir, 'bad.log') } }],
          upstreams: upstreams(),
        })
      },
      /access_log.format/,
    )
  })

  it('rejects a missing file at validation', () => {
    assert.throws(
      () => {
        server.validate({
          id: nextRouteId('alog-bad-file'),
          matcher: { rule: "PathPrefix('/alog/bad')", priority: 50 },
          middlewares: [{ type: 'access_log', config: { format: 'text' } }],
          upstreams: upstreams(),
        })
      },
      /access_log.file/,
    )
  })
})
