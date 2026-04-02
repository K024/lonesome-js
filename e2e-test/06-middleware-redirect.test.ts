import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startProxy } from './helpers/proxy.js'
import { createDynamicUpstream } from './helpers/upstream.js'
import { nextRouteId, tcpUpstream, withRoute } from './helpers/routes.js'
import { proxyFetch, assertHeader } from './helpers/request.js'
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

describe('middleware: redirect', () => {
  describe('static target_mode 302', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('redir-static'),
        matcher: { rule: "PathPrefix('/redir/static')", priority: 50 },
        middlewares: [
          { type: 'redirect', config: { code: 302, target_mode: 'static', target: 'https://example.com/new' } },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('returns 302 status', async () => {
      const res = await proxyFetch(proxyPort, '/redir/static/test', { redirect: 'manual' })
      await res.text()
      assert.strictEqual(res.status, 302)
    })
    it('returns correct location header', async () => {
      const res = await proxyFetch(proxyPort, '/redir/static/test', { redirect: 'manual' })
      await res.text()
      assertHeader(res, 'location', 'https://example.com/new')
    })
    it('returns content-length: 0', async () => {
      const res = await proxyFetch(proxyPort, '/redir/static/test', { redirect: 'manual' })
      await res.text()
      assertHeader(res, 'content-length', '0')
    })
  })

  describe('static target_mode 301', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('redir-301'),
        matcher: { rule: "PathPrefix('/redir/301')", priority: 50 },
        middlewares: [
          { type: 'redirect', config: { code: 301, target_mode: 'static', target: 'https://example.com/moved' } },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('returns 301 status', async () => {
      const res = await proxyFetch(proxyPort, '/redir/301/test', { redirect: 'manual' })
      await res.text()
      assert.strictEqual(res.status, 301)
    })
  })

  describe('cel target_mode', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('redir-cel'),
        matcher: { rule: "PathPrefix('/redir/cel')", priority: 50 },
        middlewares: [
          {
            type: 'redirect',
            config: { code: 302, target_mode: 'cel', expression: "'https://target.example.com' + PathValue()" },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('computes location from CEL expression', async () => {
      const res = await proxyFetch(proxyPort, '/redir/cel/page', { redirect: 'manual' })
      await res.text()
      assert.strictEqual(res.status, 302)
      assertHeader(res, 'location', 'https://target.example.com/redir/cel/page')
    })
  })

  describe('regex_replace target_mode', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('redir-regex'),
        matcher: { rule: "PathPrefix('/redir/re')", priority: 50 },
        middlewares: [
          {
            type: 'redirect',
            config: { code: 301, target_mode: 'regex_replace', find: '^/redir/re/(.*)$', replace: '/new/$1' },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('builds location from regex replacement', async () => {
      const res = await proxyFetch(proxyPort, '/redir/re/item/42', { redirect: 'manual' })
      await res.text()
      assert.strictEqual(res.status, 301)
      assertHeader(res, 'location', '/new/item/42')
    })
  })
})

describe('middleware: redirect_https', () => {
  describe('http → https', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('redir-https'),
        matcher: { rule: "PathPrefix('/redir/https')", priority: 50 },
        middlewares: [
          { type: 'redirect_https', config: { code: 301, port: 443, to_http: false } },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('redirects http request to https', async () => {
      const res = await proxyFetch(proxyPort, '/redir/https/page', { redirect: 'manual' })
      await res.text()
      assert.strictEqual(res.status, 301)
      assertHeader(res, 'location', 'https://127.0.0.1/redir/https/page')
    })
  })
})
