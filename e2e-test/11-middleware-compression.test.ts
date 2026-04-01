import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createGunzip, gzipSync } from 'node:zlib'
import { startProxy } from './helpers/proxy.js'
import { createDynamicUpstream } from './helpers/upstream.js'
import { nextRouteId, tcpUpstream, withRoute } from './helpers/routes.js'
import { proxyFetch, requestRawHttp } from './helpers/request.js'
import type { DenaliServer } from '../dist/index.js'

let server: DenaliServer
let proxyPort: number
const upstream = createDynamicUpstream()
const cleanups: Array<() => void> = []

before(async () => {
  await upstream.start()
  ;({ server, port: proxyPort } = await startProxy())
})

after(async () => {
  cleanups.forEach((fn) => fn())
  server.stop()
  await upstream.stop()
})

describe('middleware: compression', () => {
  describe('gzip level > 0', () => {
    before(() => {
      upstream.setHandler((_req, res) => {
        res.setHeader('content-type', 'text/plain')
        res.end('hello gzip compression world')
      })
      cleanups.push(withRoute(server, {
        id: nextRouteId('comp-gzip'),
        matcher: { rule: "PathPrefix('/comp/gzip')", priority: 50 },
        middlewares: [{ type: 'compression', config: { gzip: 6 } }],
        upstreams: tcpUpstream(upstream.port),
      }))
    })
    after(() => upstream.resetHandler())

    it('response is gzip-encoded when client accepts gzip', async () => {
      const { response, body } = await requestRawHttp(proxyPort, '/comp/gzip/test', {
        headers: { 'accept-encoding': 'gzip' },
      })
      const encoding = String(response.headers['content-encoding'] ?? '')
      assert.strictEqual(response.statusCode, 200)
      assert.strictEqual(encoding, 'gzip')
      await new Promise<void>((resolve, reject) => {
        const gz = createGunzip()
        let out = ''
        gz.on('data', (c) => { out += c })
        gz.on('end', () => {
          assert.ok(out.includes('hello'), `decompressed body should contain 'hello', got: ${out}`)
          resolve()
        })
        gz.on('error', reject)
        gz.end(body)
      })
    })
  })

  describe('gzip level = 0 (disabled)', () => {
    before(() => {
      upstream.setHandler((_req, res) => {
        res.setHeader('content-type', 'text/plain')
        res.end('no compression here')
      })
      cleanups.push(withRoute(server, {
        id: nextRouteId('comp-nogzip'),
        matcher: { rule: "PathPrefix('/comp/nogzip')", priority: 50 },
        middlewares: [{ type: 'compression', config: { gzip: 0 } }],
        upstreams: tcpUpstream(upstream.port),
      }))
    })
    after(() => upstream.resetHandler())

    it('response is not gzip-encoded when level is 0', async () => {
      const res = await proxyFetch(proxyPort, '/comp/nogzip/test', { headers: { 'accept-encoding': 'gzip' } })
      const encoding = res.headers.get('content-encoding') || ''
      await res.text()
      assert.ok(encoding === '', `expected no gzip encoding, got: ${encoding}`)
    })
  })

  describe('brotli level > 0', () => {
    before(() => {
      upstream.setHandler((_req, res) => {
        res.setHeader('content-type', 'text/plain')
        res.end('hello brotli compression world')
      })
      cleanups.push(withRoute(server, {
        id: nextRouteId('comp-br'),
        matcher: { rule: "PathPrefix('/comp/br')", priority: 50 },
        middlewares: [{ type: 'compression', config: { br: 4 } }],
        upstreams: tcpUpstream(upstream.port),
      }))
    })
    after(() => upstream.resetHandler())

    it('response is br-encoded when client accepts br', async () => {
      const { response, body } = await requestRawHttp(proxyPort, '/comp/br/test', {
        headers: { 'accept-encoding': 'br' },
      })
      const encoding = String(response.headers['content-encoding'] ?? '')
      assert.strictEqual(response.statusCode, 200)
      assert.strictEqual(encoding, 'br')
      assert.ok(body.length > 0, 'raw br body should not be empty')

      // Node fetch auto-decompresses; verify end-user-visible payload is correct.
      // zlib.brotliDecompressSync is not correctly working
      const decoded = await proxyFetch(proxyPort, '/comp/br/test', {
        headers: { 'accept-encoding': 'br' },
      })
      const decodedEncoding = decoded.headers.get('content-encoding') ?? ''
      const text = await decoded.text()
      assert.strictEqual(decodedEncoding, 'br')
      assert.ok(text.includes('hello brotli compression world'), `decoded body mismatch: ${text}`)
    })
  })

  describe('decompress_upstream=true', () => {
    before(() => {
      upstream.setHandler((_req, res) => {
        const compressed = gzipSync('upstream sent gzip')
        res.setHeader('content-encoding', 'gzip')
        res.setHeader('content-type', 'text/plain')
        res.end(compressed)
      })
      cleanups.push(withRoute(server, {
        id: nextRouteId('comp-decompup'),
        matcher: { rule: "PathPrefix('/comp/decompup')", priority: 50 },
        middlewares: [{ type: 'compression', config: { decompress_upstream: true } }],
        upstreams: tcpUpstream(upstream.port),
      }))
    })
    after(() => upstream.resetHandler())

    it('proxy decompresses upstream gzip and client receives plain text', async () => {
      const { response, body } = await requestRawHttp(proxyPort, '/comp/decompup/test')
      const encoding = String(response.headers['content-encoding'] ?? '')
      const text = body.toString('utf8')
      assert.ok(encoding !== 'gzip', `response to plain client should not be gzip, got: ${encoding}`)
      assert.ok(text.includes('upstream sent gzip'), `body should be decompressed, got: ${text}`)
    })
  })
})
