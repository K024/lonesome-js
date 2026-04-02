import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { DenaliServer } from '../dist/index.js'
import type { DenaliServer as DenaliServerType } from '../dist/index.js'
import { createDynamicUpstream } from './helpers/upstream.js'
import { nextRouteId, tcpUpstream, withRoute } from './helpers/routes.js'
import { requestRawHttps } from './helpers/request.js'
import { pickFreePort, sleep } from './helpers/proxy.js'
import { generateSelfSignedTlsCert } from './helpers/tls.js'
import { request as httpRequest } from 'node:http'

let server: DenaliServerType
let httpPort: number
let tlsPort: number
let tlsCleanup: (() => void) | undefined
const upstream = createDynamicUpstream()
const cleanups: Array<() => void> = []

before(async () => {
  await upstream.start()
  httpPort = await pickFreePort()
  tlsPort = await pickFreePort()

  const cert = generateSelfSignedTlsCert('127.0.0.1')
  tlsCleanup = cert.cleanup

  server = new DenaliServer()
  server.start({
    listeners: [
      {
        kind: 'tcp',
        addr: `127.0.0.1:${httpPort}`,
      },
      {
        kind: 'tls',
        addr: `127.0.0.1:${tlsPort}`,
        certPath: cert.certPath,
        keyPath: cert.keyPath,
      },
    ],
  })

  await sleep(600)
})

after(async () => {
  cleanups.forEach((fn) => fn())
  server.stop()
  await upstream.stop()
  tlsCleanup?.()
})

describe('middleware: redirect_https over tls listener', () => {
  const insecureAgent = new https.Agent({ rejectUnauthorized: false })

  describe('to_http=false on tcp listener', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('redirhttps-tohttps'),
        matcher: { rule: "PathPrefix('/redirhttps/to-https')", priority: 50 },
        middlewares: [{ type: 'redirect_https', config: { code: 301, to_http: false, port: tlsPort } }],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('redirects HTTP requests to HTTPS on configured TLS port', async () => {
      const { statusCode, headers, body } = await new Promise<{
        statusCode: number
        headers: Record<string, string | string[] | undefined>
        body: Buffer
      }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port: httpPort,
            path: '/redirhttps/to-https/path?a=1',
            method: 'GET',
            headers: { host: `example.local:${httpPort}` },
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
            })
            res.on('end', () => {
              resolve({
                statusCode: res.statusCode ?? 0,
                headers: res.headers as Record<string, string | string[] | undefined>,
                body: Buffer.concat(chunks),
              })
            })
          },
        )
        req.on('error', reject)
        req.end()
      })

      assert.strictEqual(statusCode, 301)
      assert.strictEqual(
        String(headers.location ?? ''),
        `https://example.local:${tlsPort}/redirhttps/to-https/path?a=1`,
      )
      assert.strictEqual(String(headers['content-length'] ?? ''), '0')
      assert.strictEqual(body.length, 0)
    })
  })

  describe('to_http=true', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('redirhttps-tohttp'),
        matcher: { rule: "PathPrefix('/redirhttps/to-http')", priority: 50 },
        middlewares: [{ type: 'redirect_https', config: { code: 302, to_http: true, port: 8080 } }],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('redirects HTTPS requests to HTTP with configured port', async () => {
      const { response, body } = await requestRawHttps(tlsPort, '/redirhttps/to-http/page?x=1', {
        agent: insecureAgent,
        headers: { host: 'secure.local:9443' },
      })

      assert.strictEqual(response.statusCode, 302)
      assert.strictEqual(String(response.headers.location ?? ''), 'http://secure.local:8080/redirhttps/to-http/page?x=1')
      assert.strictEqual(String(response.headers['content-length'] ?? ''), '0')
      assert.strictEqual(body.length, 0)
    })

    it('redirects HTTPS requests to HTTP default port when port is omitted', async () => {
      const id = nextRouteId('redirhttps-tohttp-default-port')
      const clean = withRoute(server, {
        id,
        matcher: { rule: "PathPrefix('/redirhttps/to-http-default')", priority: 55 },
        middlewares: [{ type: 'redirect_https', config: { code: 302, to_http: true } }],
        upstreams: tcpUpstream(upstream.port),
      })

      const { response, body } = await requestRawHttps(
        tlsPort,
        '/redirhttps/to-http-default/page?y=2',
        {
          agent: insecureAgent,
          headers: { host: 'secure.local:9443' },
        },
      )

      assert.strictEqual(response.statusCode, 302)
      assert.strictEqual(
        String(response.headers.location ?? ''),
        'http://secure.local/redirhttps/to-http-default/page?y=2',
      )
      assert.strictEqual(String(response.headers['content-length'] ?? ''), '0')
      assert.strictEqual(body.length, 0)

      clean()
    })
  })

  describe('rule gating', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('redirhttps-rule'),
        matcher: { rule: "PathPrefix('/redirhttps/rule')", priority: 50 },
        middlewares: [{ type: 'redirect_https', config: { code: 302, to_http: true, rule: "Method('POST')" } }],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('does not redirect when CEL rule does not match', async () => {
      const { response, body } = await requestRawHttps(tlsPort, '/redirhttps/rule/check', {
        agent: insecureAgent,
      })

      assert.strictEqual(response.statusCode, 200)
      const payload = JSON.parse(body.toString('utf8'))
      assert.strictEqual(payload.url, '/redirhttps/rule/check')
      assert.strictEqual(payload.method, 'GET')
    })
  })
})
