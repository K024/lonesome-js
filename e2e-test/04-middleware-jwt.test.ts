import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import {
  CompactEncrypt,
  SignJWT,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importPKCS8,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from 'jose'
import { startProxy } from './helpers/proxy.js'
import { createDynamicUpstream } from './helpers/upstream.js'
import { nextRouteId, tcpUpstream, withRoute } from './helpers/routes.js'
import { getJson, proxyFetch } from './helpers/request.js'
import type { LonesomeServer } from '../dist/index.js'

let server: LonesomeServer
let proxyPort: number
const upstream = createDynamicUpstream()
const cleanups: Array<() => void> = []

let hmac256Secret = ''
let hmac512Secret = ''
let jweDirKey: Uint8Array | null = null
let rsaPrivatePem = ''
let jwksJson = ''

function b64url(input: string | Buffer): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8')
  return buf.toString('base64url')
}

function randomSecret(byteLen = 48): string {
  return randomBytes(byteLen).toString('base64url')
}

function randomKeyBytes(byteLen: number): Uint8Array {
  return new Uint8Array(randomBytes(byteLen))
}

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000)
}

async function signHs(
  payload: JWTPayload,
  alg: 'HS256' | 'HS512',
  secret: string,
  kid: string,
): Promise<string> {
  const key = new TextEncoder().encode(secret)
  return new SignJWT(payload).setProtectedHeader({ alg, typ: 'JWT', kid }).sign(key)
}

async function signRs256(payload: JWTPayload, privatePem: string, kid: string): Promise<string> {
  const privateKey = await importPKCS8(privatePem, 'RS256')
  return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid }).sign(privateKey)
}

async function encryptDirA256Gcm(payload: object, secret: Uint8Array, kid = 'jwe-dir-1'): Promise<string> {
  const cek = secret
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  return new CompactEncrypt(plaintext).setProtectedHeader({ alg: 'dir', enc: 'A256GCM', kid }).encrypt(cek)
}

before(async () => {
  await upstream.start()
    ; ({ server, port: proxyPort } = await startProxy())

  hmac256Secret = randomSecret(64)
  hmac512Secret = randomSecret(96)
  jweDirKey = randomKeyBytes(32)

  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  rsaPrivatePem = await exportPKCS8(privateKey)

  const rsaPubJwk = await createPublicJwk(publicKey)
  const hmac256Jwk = createHmacJwk(hmac256Secret, 'hmac-256', 'HS256')
  const hmac512Jwk = createHmacJwk(hmac512Secret, 'hmac-512', 'HS512')
  const jweDirJwk = createJweDirJwk(jweDirKey, 'jwe-dir-1')
  jwksJson = JSON.stringify({ keys: [hmac256Jwk, hmac512Jwk, rsaPubJwk, jweDirJwk] })
})

after(async () => {
  cleanups.forEach((fn) => fn())
  server.stop()
  await upstream.stop()
})

function createHmacJwk(secret: string, kid: string | undefined, alg: 'HS256' | 'HS512'): JWK {
  const jwk: JWK = {
    kty: 'oct',
    alg,
    use: 'sig',
    k: b64url(Buffer.from(secret, 'utf8')),
  }
  if (kid) jwk.kid = kid
  return jwk
}

function createJweDirJwk(secret: Uint8Array, kid: string): JWK {
  return {
    kty: 'oct',
    kid,
    alg: 'dir',
    use: 'enc',
    key_ops: ['encrypt', 'decrypt'],
    k: b64url(Buffer.from(secret)),
  }
}

async function createPublicJwk(publicKey: CryptoKey): Promise<JWK> {
  const jwk = await exportJWK(publicKey)
  return {
    kty: 'RSA',
    kid: 'rsa-1',
    alg: 'RS256',
    use: 'sig',
    n: jwk.n,
    e: jwk.e,
  }
}

describe('middleware: jwt (jwks only)', () => {
  describe('hmac jwt verify + cel access', () => {
    before(() => {
      cleanups.push(
        withRoute(server, {
          id: nextRouteId('jwt-hs256'),
          matcher: { rule: "PathPrefix('/jwt/hs256')", priority: 60 },
          middlewares: [
            {
              type: 'jwt',
              config: {
                jwks: jwksJson,
              },
            },
            {
              type: 'request_headers',
              config: {
                name: 'x-jwt-claim-sub',
                action: 'set',
                expression: "JwtClaimValue('sub')",
              },
            },
            {
              type: 'request_headers',
              config: {
                name: 'x-jwt-payload',
                action: 'set',
                expression: 'JwtPayloadValue()',
              },
            },
            {
              type: 'request_headers',
              config: {
                name: 'x-jwt-is-admin',
                action: 'set',
                rule: "JwtClaim('role', 'admin')",
                value: 'true',
              },
            },
          ],
          upstreams: tcpUpstream(upstream.port),
        }),
      )
    })

    it('returns 401 when missing token', async () => {
      const res = await proxyFetch(proxyPort, '/jwt/hs256/need-auth')
      await res.text()
      assert.strictEqual(res.status, 401)
    })

    it('verifies HS256 token and writes claim/payload into cel context', async () => {
      const token = await signHs({ sub: 'alice', role: 'admin' }, 'HS256', hmac256Secret, 'hmac-256')
      const { body } = await getJson(proxyPort, '/jwt/hs256/ok', {
        headers: { authorization: `Bearer ${token}` },
      })

      assert.strictEqual(body.headers['x-jwt-claim-sub'], 'alice')
      assert.strictEqual(body.headers['x-jwt-is-admin'], 'true')

      const payload = JSON.parse(body.headers['x-jwt-payload'])
      assert.strictEqual(payload.sub, 'alice')
      assert.strictEqual(payload.role, 'admin')
    })

    it('verifies HS512 token when jwks contains matching oct key', async () => {
      const token = await signHs({ sub: 'h512-user' }, 'HS512', hmac512Secret, 'hmac-512')
      const { body } = await getJson(proxyPort, '/jwt/hs256/hs512', {
        headers: { authorization: `Bearer ${token}` },
      })
      assert.strictEqual(body.headers['x-jwt-claim-sub'], 'h512-user')
    })

    it('denies JWT when signature is invalid', async () => {
      const token = await signHs({ sub: 'alice' }, 'HS256', randomSecret(64), 'hmac-256')
      const res = await proxyFetch(proxyPort, '/jwt/hs256/bad-signature', {
        headers: { authorization: `Bearer ${token}` },
      })
      await res.text()
      assert.strictEqual(res.status, 401)
    })
  })

  describe('custom header + rsa verify', () => {
    before(() => {
      cleanups.push(
        withRoute(server, {
          id: nextRouteId('jwt-rs256'),
          matcher: { rule: "PathPrefix('/jwt/rs256')", priority: 60 },
          middlewares: [
            {
              type: 'jwt',
              config: {
                header_name: 'x-auth-token',
                bearer_prefix: '',
                jwks: jwksJson,
              },
            },
            {
              type: 'request_headers',
              config: {
                name: 'x-jwt-from-rs',
                action: 'set',
                expression: "JwtClaimValue('sub')",
              },
            },
          ],
          upstreams: tcpUpstream(upstream.port),
        }),
      )
    })

    it('denies invalid token', async () => {
      const res = await proxyFetch(proxyPort, '/jwt/rs256/denied', {
        headers: { 'x-auth-token': 'invalid.jwt.value' },
      })
      await res.text()
      assert.strictEqual(res.status, 401)
    })

    it('accepts valid RS256 token from custom header', async () => {
      const token = await signRs256({ sub: 'bob', source: 'rsa' }, rsaPrivatePem, 'rsa-1')
      const { body } = await getJson(proxyPort, '/jwt/rs256/ok', {
        headers: { 'x-auth-token': token },
      })
      assert.strictEqual(body.headers['x-jwt-from-rs'], 'bob')
    })
  })

  describe('jwe behavior (success + failure)', () => {
    before(() => {
      cleanups.push(
        withRoute(server, {
          id: nextRouteId('jwt-jwe-pass'),
          matcher: { rule: "PathPrefix('/jwt/jwe')", priority: 60 },
          middlewares: [
            {
              type: 'jwt',
              config: {
                jwks: jwksJson,
                on_error: 'passthrough',
                rule: "Query('check', '1')",
              },
            },
            {
              type: 'request_headers',
              config: {
                name: 'x-jwt-sub',
                action: 'set',
                rule: "JwtClaimValue('sub') != null",
                expression: "JwtClaimValue('sub')",
              },
            },
            {
              type: 'request_headers',
              config: {
                name: 'x-jwt-payload',
                action: 'set',
                rule: "JwtPayloadValue() != ''",
                expression: 'JwtPayloadValue()',
              },
            },
          ],
          upstreams: tcpUpstream(upstream.port),
        }),
      )

      cleanups.push(
        withRoute(server, {
          id: nextRouteId('jwt-jwe-deny'),
          matcher: { rule: "PathPrefix('/jwt/jwe-deny')", priority: 60 },
          middlewares: [
            {
              type: 'jwt',
              config: {
                jwks: jwksJson,
              },
            },
          ],
          upstreams: tcpUpstream(upstream.port),
        }),
      )
    })

    it('passes through invalid compact token when on_error=passthrough', async () => {
      const { res, body } = await getJson(proxyPort, '/jwt/jwe/check?check=1', {
        headers: { authorization: 'Bearer invalid.jwt' },
      })
      assert.strictEqual(res.status, 200)
      assert.strictEqual(body.headers['x-jwt-sub'], undefined)
      assert.strictEqual(body.headers['x-jwt-payload'], undefined)
    })

    it('decrypts JWE token and exposes payload in CEL when on_error=passthrough', async () => {
      const jweToken = await encryptDirA256Gcm({ sub: 'eve', role: 'enc' }, jweDirKey!)
      const { res, body } = await getJson(proxyPort, '/jwt/jwe/check?check=1', {
        headers: { authorization: `Bearer ${jweToken}` },
      })
      assert.strictEqual(res.status, 200)
      assert.strictEqual(body.headers['x-jwt-sub'], 'eve')

      const payload = JSON.parse(body.headers['x-jwt-payload'])
      assert.strictEqual(payload.sub, 'eve')
      assert.strictEqual(payload.role, 'enc')
    })

    it('denies JWE token with wrong key in default deny mode', async () => {
      const jweToken = await encryptDirA256Gcm({ sub: 'mallory' }, randomKeyBytes(32))
      const res = await proxyFetch(proxyPort, '/jwt/jwe-deny/blocked', {
        headers: { authorization: `Bearer ${jweToken}` },
      })
      await res.text()
      assert.strictEqual(res.status, 401)
    })
  })

  describe('time validation (exp + nbf)', () => {
    before(() => {
      cleanups.push(
        withRoute(server, {
          id: nextRouteId('jwt-time-check'),
          matcher: { rule: "PathPrefix('/jwt/time')", priority: 60 },
          middlewares: [
            {
              type: 'jwt',
              config: {
                jwks: jwksJson,
                validate_time: true,
              },
            },
            {
              type: 'request_headers',
              config: {
                name: 'x-jwt-time-sub',
                action: 'set',
                expression: "JwtClaimValue('sub')",
              },
            },
          ],
          upstreams: tcpUpstream(upstream.port),
        }),
      )
    })

    it('accepts token with valid exp/nbf window', async () => {
      const now = nowEpoch()
      const token = await signHs(
        { sub: 'timed-ok', nbf: now - 10, exp: now + 120 },
        'HS256',
        hmac256Secret,
        'hmac-256',
      )

      const { res, body } = await getJson(proxyPort, '/jwt/time/ok', {
        headers: { authorization: `Bearer ${token}` },
      })
      assert.strictEqual(res.status, 200)
      assert.strictEqual(body.headers['x-jwt-time-sub'], 'timed-ok')
    })

    it('denies expired token when validate_time=true', async () => {
      const now = nowEpoch()
      const token = await signHs(
        { sub: 'expired', nbf: now - 60, exp: now - 5 },
        'HS256',
        hmac256Secret,
        'hmac-256',
      )

      const res = await proxyFetch(proxyPort, '/jwt/time/expired', {
        headers: { authorization: `Bearer ${token}` },
      })
      await res.text()
      assert.strictEqual(res.status, 401)
    })

    it('denies token with future nbf when validate_time=true', async () => {
      const now = nowEpoch()
      const token = await signHs(
        { sub: 'future', nbf: now + 120, exp: now + 360 },
        'HS256',
        hmac256Secret,
        'hmac-256',
      )

      const res = await proxyFetch(proxyPort, '/jwt/time/not-before', {
        headers: { authorization: `Bearer ${token}` },
      })
      await res.text()
      assert.strictEqual(res.status, 401)
    })
  })

  describe('middleware: jwt key rotation (same alg, multiple keys)', () => {
    const rotatedSecret = randomSecret(64)
    const rotatedKid = 'hmac-256-rotated'
    let rotatedJwks = ''

    before(() => {
      rotatedJwks = JSON.stringify({
        keys: [
          createHmacJwk(hmac256Secret, 'hmac-256', 'HS256'),
          createHmacJwk(rotatedSecret, rotatedKid, 'HS256'),
        ],
      })
      cleanups.push(
        withRoute(server, {
          id: nextRouteId('jwt-rotation-hs256-new'),
          matcher: { rule: "PathPrefix('/jwt/rotation')", priority: 61 },
          middlewares: [
            {
              type: 'jwt',
              config: {
                jwks: rotatedJwks,
              },
            },
            {
              type: 'request_headers',
              config: {
                name: 'x-rot-sub',
                action: 'set',
                expression: "JwtClaimValue('sub')",
              },
            },
          ],
          upstreams: tcpUpstream(upstream.port),
        }),
      )
    })

    it('accepts old HS256 kid', async () => {
      const token = await signHs({ sub: 'old-key-user' }, 'HS256', hmac256Secret, 'hmac-256')
      const { res, body } = await getJson(proxyPort, '/jwt/rotation/ok', {
        headers: { authorization: `Bearer ${token}` },
      })

      assert.strictEqual(res.status, 200)
      assert.strictEqual(body.headers['x-rot-sub'], 'old-key-user')
    })

    it('accepts rotated HS256 kid', async () => {
      const token = await signHs({ sub: 'new-key-user' }, 'HS256', rotatedSecret, rotatedKid)
      const { res, body } = await getJson(proxyPort, '/jwt/rotation/ok', {
        headers: { authorization: `Bearer ${token}` },
      })

      assert.strictEqual(res.status, 200)
      assert.strictEqual(body.headers['x-rot-sub'], 'new-key-user')
    })
  })

  describe('middleware: jwt without kid', () => {
    const secretA = randomSecret(64)
    const secretB = randomSecret(64)
    const noKidJwks = JSON.stringify({
      keys: [
        createHmacJwk(secretA, undefined, 'HS256'),
        createHmacJwk(secretB, undefined, 'HS256'),
      ],
    })

    before(() => {
      cleanups.push(
        withRoute(server, {
          id: nextRouteId('jwt-no-kid'),
          matcher: { rule: "PathPrefix('/jwt/no-kid')", priority: 70 },
          middlewares: [
            {
              type: 'jwt',
              config: {
                jwks: noKidJwks,
              },
            },
            {
              type: 'request_headers',
              config: {
                name: 'x-no-kid-sub',
                action: 'set',
                expression: "JwtClaimValue('sub')",
              },
            },
          ],
          upstreams: tcpUpstream(upstream.port),
        }),
      )
    })

    it('verifies token signed by secretA without kid', async () => {
      const tokenA = await new SignJWT({ sub: 'no-kid-user-a' })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .sign(new TextEncoder().encode(secretA))

      const { res, body } = await getJson(proxyPort, '/jwt/no-kid/a', {
        headers: { authorization: `Bearer ${tokenA}` },
      })

      assert.strictEqual(res.status, 200)
      assert.strictEqual(body.headers['x-no-kid-sub'], 'no-kid-user-a')
    })

    it('verifies token signed by secretB without kid', async () => {
      const tokenB = await new SignJWT({ sub: 'no-kid-user-b' })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .sign(new TextEncoder().encode(secretB))

      const { res, body } = await getJson(proxyPort, '/jwt/no-kid/b', {
        headers: { authorization: `Bearer ${tokenB}` },
      })

      assert.strictEqual(res.status, 200)
      assert.strictEqual(body.headers['x-no-kid-sub'], 'no-kid-user-b')
    })
  })
})
