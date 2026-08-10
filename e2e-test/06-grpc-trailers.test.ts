import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http2 from 'node:http2'
import { readFileSync } from 'node:fs'
import { LonesomeServer } from '../dist/index.js'
import type { LonesomeServer as LonesomeServerType } from '../dist/index.js'
import { nextRouteId, withRoute } from './helpers/routes.js'
import { pickFreePort, sleep } from './helpers/proxy.js'
import { generateSelfSignedTlsCert, hasOpenssl } from './helpers/tls.js'
import { conditionalDescribe } from './helpers/conditional_describe.js'

const skipWithoutOpenssl = hasOpenssl() ? false : 'requires openssl CLI (not available on this host)'

/**
 * gRPC is HTTP/2 carrying the result in the `grpc-status` TRAILER. This test
 * verifies that the proxy forwards HTTP/2 + trailers end-to-end (downstream h2
 * -> h2c upstream) without any special handling.
 */
conditionalDescribe('gRPC / HTTP/2 trailers passthrough', skipWithoutOpenssl, () => {
  let server: LonesomeServerType
  let port: number
  let h2cPort: number
  let h2cServer: http2.Http2Server
  let cleanup: Array<() => void> = []

  before(async () => {
    // h2c upstream that answers like a minimal gRPC service, with grpc-status in trailers
    h2cServer = http2.createServer()
    h2cServer.on('stream', (stream: http2.ServerHttp2Stream) => {
      stream.respond(
        { ':status': 200, 'content-type': 'application/grpc' },
        { waitForTrailers: true },
      )
      stream.end(Buffer.from('grpc-payload'))
      stream.on('wantTrailers', () => {
        stream.sendTrailers({ 'grpc-status': '0', 'grpc-message': 'ok' })
      })
    })
    await new Promise<void>((resolve) => h2cServer.listen(0, '127.0.0.1', resolve))
    h2cPort = (h2cServer.address() as { port: number }).port

    port = await pickFreePort()
    const cert = generateSelfSignedTlsCert('127.0.0.1')
    server = new LonesomeServer()
    server.start({
      listeners: [{
        kind: 'tls',
        addr: `127.0.0.1:${port}`,
        certPath: cert.certPath,
        keyPath: cert.keyPath,
      }],
    })
    await sleep(600)

    cleanup.push(withRoute(server, {
      id: nextRouteId('grpc'),
      matcher: { rule: "PathPrefix('/grpc')", priority: 50 },
      middlewares: [],
      upstreams: [{
        kind: 'tcp',
        address: `127.0.0.1:${h2cPort}`,
        tls: false,
        h2c: true,
        sni: '',
        weight: 1,
      }],
    }))
  })

  after(async () => {
    cleanup.forEach((fn) => fn())
    try {
      server?.stop()
    } catch {
      // ok
    }
    await new Promise<void>((resolve) => h2cServer.close(() => resolve()))
  })

  it('forwards HTTP/2 headers and trailers to the downstream client', async () => {
    const client = http2.connect(`https://127.0.0.1:${port}`, {
      rejectUnauthorized: false,
    })

    const responseHeaders = await new Promise<http2.IncomingHttpHeaders>((resolve, reject) => {
      const req = client.request({ ':path': '/grpc/hello', ':method': 'POST' })
      req.on('error', reject)
      req.on('response', (headers) => resolve(headers))
      req.end()
    })

    const result = await new Promise<{ body: Buffer; trailers: http2.IncomingHttpHeaders }>(
      (resolve, reject) => {
        const req = client.request({ ':path': '/grpc/hello', ':method': 'POST' })
        const chunks: Buffer[] = []
        let trailers: http2.IncomingHttpHeaders = {}
        req.on('error', reject)
        req.on('data', (c) => chunks.push(Buffer.from(c)))
        req.on('trailers', (h) => {
          trailers = h
        })
        req.on('end', () => resolve({ body: Buffer.concat(chunks), trailers }))
        req.end()
      },
    )

    assert.strictEqual(responseHeaders[':status'], 200)
    assert.strictEqual(responseHeaders['content-type'], 'application/grpc')
    assert.strictEqual(result.body.toString('utf8'), 'grpc-payload')
    // gRPC status arrives as a trailer and must survive the proxy hop
    assert.strictEqual(result.trailers['grpc-status'], '0')
    assert.strictEqual(result.trailers['grpc-message'], 'ok')

    client.close()
  })
})
