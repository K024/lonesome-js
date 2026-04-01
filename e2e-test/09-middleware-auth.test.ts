import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startProxy } from './helpers/proxy.js'
import { createDynamicUpstream } from './helpers/upstream.js'
import { nextRouteId, tcpUpstream, withRoute } from './helpers/routes.js'
import { proxyFetch } from './helpers/request.js'
import type { DenaliServer } from '../dist/index.js'
import crypto from 'node:crypto'

let server: DenaliServer
let proxyPort: number
const upstream = createDynamicUpstream()
const cleanups: Array<() => void> = []

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16)
  const iterations = 10000
  const keyLength = 64
  const digest = 'sha512'

  const derivedKey = crypto.pbkdf2Sync(
    password, 
    salt, 
    iterations, 
    keyLength, 
    digest
  )

  // password-auth uses PHC-like hashes; use standard base64 fields to keep format compatible.
  const saltB64 = salt.toString('base64').replace(/=+$/g, '')
  const hashB64 = derivedKey.toString('base64').replace(/=+$/g, '')
  return `$pbkdf2-${digest}$i=${iterations},l=${keyLength}$${saltB64}$${hashB64}`
}

const PASSWORD_HASH = hashPassword('secret123')
const CORRECT_CREDENTIALS = Buffer.from('alice:secret123').toString('base64')
const WRONG_CREDENTIALS = Buffer.from('alice:wrongpassword').toString('base64')

before(async () => {
  await upstream.start()
    ; ({ server, port: proxyPort } = await startProxy())
})

after(async () => {
  cleanups.forEach((fn) => fn())
  server.stop()
  await upstream.stop()
})

describe('middleware: basic_auth', () => {
  describe('authentication required', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('auth'),
        matcher: { rule: "PathPrefix('/auth/protected')", priority: 50 },
        middlewares: [
          { type: 'basic_auth', config: { realm: 'Test Realm', users: [{ name: 'alice', password_hash: PASSWORD_HASH }] } },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('returns 401 when no Authorization header is sent', async () => {
      const res = await proxyFetch(proxyPort, '/auth/protected/resource')
      await res.text()
      assert.strictEqual(res.status, 401)
    })
    it('returns WWW-Authenticate header on 401', async () => {
      const res = await proxyFetch(proxyPort, '/auth/protected/resource')
      await res.text()
      const wwwAuth = res.headers.get('www-authenticate') ?? ''
      assert.ok(wwwAuth.startsWith('Basic'), `expected Basic scheme, got: ${wwwAuth}`)
      assert.ok(wwwAuth.includes('Test Realm'), `expected realm, got: ${wwwAuth}`)
    })
    it('returns 401 for wrong password', async () => {
      const res = await proxyFetch(proxyPort, '/auth/protected/resource', {
        headers: { authorization: `Basic ${WRONG_CREDENTIALS}` },
      })
      await res.text()
      assert.strictEqual(res.status, 401)
    })
    it('returns 200 for correct credentials', async () => {
      const res = await proxyFetch(proxyPort, '/auth/protected/resource', {
        headers: { authorization: `Basic ${CORRECT_CREDENTIALS}` },
      })
      await res.text()
      assert.strictEqual(res.status, 200)
    })
  })

  describe('CEL rule condition', () => {
    before(() => {
      cleanups.push(withRoute(server, {
        id: nextRouteId('auth-rule'),
        matcher: { rule: "PathPrefix('/auth/rule')", priority: 50 },
        middlewares: [
          {
            type: 'basic_auth',
            config: {
              realm: 'Conditional',
              users: [{ name: 'alice', password_hash: PASSWORD_HASH }],
              rule: "PathPrefix('/auth/rule/secure')",
            },
          },
        ],
        upstreams: tcpUpstream(upstream.port),
      }))
    })

    it('requires auth when path matches rule', async () => {
      const res = await proxyFetch(proxyPort, '/auth/rule/secure/data')
      await res.text()
      assert.strictEqual(res.status, 401)
    })
    it('bypasses auth when path does not match rule', async () => {
      const res = await proxyFetch(proxyPort, '/auth/rule/public/data')
      await res.text()
      assert.strictEqual(res.status, 200)
    })
  })
})
