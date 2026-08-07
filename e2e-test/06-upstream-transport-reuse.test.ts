import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { LonesomeServer, UpstreamConfig } from '../dist/index.js'
import { startProxy } from './helpers/proxy.js'
import { proxyFetch } from './helpers/request.js'
import { nextRouteId, withRoute } from './helpers/routes.js'

type CountingUpstream = {
  endpoint: UpstreamConfig
  connections: () => number
  requests: () => number
  start: () => Promise<void>
  stop: () => Promise<void>
}

function createCountingTcpUpstream(): CountingUpstream {
  let connections = 0
  let requests = 0
  const server = createServer((_req, res) => {
    requests += 1
    res.end('ok')
  })
  server.on('connection', () => {
    connections += 1
  })

  let port = 0
  return {
    get endpoint() {
      return {
        kind: 'tcp' as const,
        address: `127.0.0.1:${port}`,
        tls: false,
        sni: '',
        weight: 1,
      }
    },
    connections: () => connections,
    requests: () => requests,
    async start() {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      port = (server.address() as AddressInfo).port
    },
    async stop() {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    },
  }
}

async function createCountingUnixUpstream(): Promise<CountingUpstream> {
  let connections = 0
  let requests = 0
  const dir = await mkdtemp(join(tmpdir(), 'lonesome-reuse-'))
  const path = join(dir, 'upstream.sock')
  const server = createServer((_req, res) => {
    requests += 1
    res.end('ok')
  })
  server.on('connection', () => {
    connections += 1
  })

  return {
    endpoint: { kind: 'unix', address: path, tls: false, sni: '', weight: 1 },
    connections: () => connections,
    requests: () => requests,
    async start() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(path, () => {
          server.off('error', reject)
          resolve()
        })
      })
    },
    async stop() {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
      await rm(dir, { recursive: true, force: true })
    },
  }
}

async function makeRequests(port: number, path: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const res = await proxyFetch(port, path)
    await res.text()
    assert.strictEqual(res.status, 200)
  }
}

describe('TCP and Unix upstream connection reuse', () => {
  let server: LonesomeServer
  let proxyPort: number
  let tcp: CountingUpstream
  let unix: CountingUpstream
  let cleanupTcp: () => void
  let cleanupUnix: () => void

  before(async () => {
    tcp = createCountingTcpUpstream()
    unix = await createCountingUnixUpstream()
    await tcp.start()
    await unix.start()
    ;({ server, port: proxyPort } = await startProxy())

    cleanupTcp = withRoute(server, {
      id: nextRouteId('tcp-reuse'),
      matcher: { rule: "PathPrefix('/reuse/tcp')", priority: 80 },
      middlewares: [],
      upstreams: [tcp.endpoint],
    })
    cleanupUnix = withRoute(server, {
      id: nextRouteId('unix-reuse'),
      matcher: { rule: "PathPrefix('/reuse/unix')", priority: 80 },
      middlewares: [],
      upstreams: [unix.endpoint],
    })
  })

  after(async () => {
    cleanupTcp()
    cleanupUnix()
    server.stop()
    await tcp.stop()
    await unix.stop()
  })

  it('reuses sequential HTTP/1 upstream connections for both transports', async () => {
    const requestCount = 12
    await makeRequests(proxyPort, '/reuse/tcp/item', requestCount)
    await makeRequests(proxyPort, '/reuse/unix/item', requestCount)

    assert.strictEqual(tcp.requests(), requestCount)
    assert.strictEqual(unix.requests(), requestCount)
    assert.ok(tcp.connections() < requestCount, `TCP did not reuse: ${tcp.connections()} connections`)
    assert.ok(unix.connections() < requestCount, `Unix did not reuse: ${unix.connections()} connections`)
    assert.ok(
      unix.connections() <= tcp.connections() + 1,
      `Unix reuse is materially worse than TCP: tcp=${tcp.connections()}, unix=${unix.connections()}`,
    )
  })
})
