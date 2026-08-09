import { it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import tls from 'node:tls'
import { readFileSync } from 'node:fs'
import { LonesomeServer } from '../dist/index.js'
import type { LonesomeServer as LonesomeServerType } from '../dist/index.js'
import { pickFreePort, sleep } from './helpers/proxy.js'
import { generateSelfSignedTlsCert, hasOpenssl } from './helpers/tls.js'
import { conditionalDescribe } from './helpers/conditional_describe.js'

const skipWithoutOpenssl = hasOpenssl() ? false : 'requires openssl CLI (not available on this host)'

conditionalDescribe('dynamic TLS certs (SNI)', skipWithoutOpenssl, () => {
  let server: LonesomeServerType
  let tlsPort: number

  const defaultCert = generateSelfSignedTlsCert('default.local')
  const globalCert = generateSelfSignedTlsCert('global2.local')
  const apiCert = generateSelfSignedTlsCert('api.example.com', 'api.example.com')
  const apiCert2 = generateSelfSignedTlsCert('api2.example.com', 'api.example.com')
  const wildcardCert = generateSelfSignedTlsCert('*.example.com', '*.example.com')
  const multiWildcardCert = generateSelfSignedTlsCert('*.b.example.com', '*.b.example.com')
  const cleanups = [defaultCert, globalCert, apiCert, apiCert2, wildcardCert, multiWildcardCert].map((c) => c.cleanup)

  const certPem = (c: typeof defaultCert) => readFileSync(c.certPath, 'utf8')
  const keyPem = (c: typeof defaultCert) => readFileSync(c.keyPath, 'utf8')

  function getServedCNOn(port: number, servername: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect(
        { host: '127.0.0.1', port, servername, rejectUnauthorized: false },
        () => {
          const cn = socket.getPeerCertificate()?.subject?.CN
          const cnStr = Array.isArray(cn) ? cn.join(',') : (cn ?? '')
          socket.destroy()
          resolve(cnStr)
        },
      )
      socket.on('error', reject)
    })
  }

  function getServedCN(servername: string): Promise<string> {
    return getServedCNOn(tlsPort, servername)
  }

  before(async () => {
    tlsPort = await pickFreePort()
    server = new LonesomeServer()
    server.start({
      listeners: [{
        kind: 'tls',
        addr: `127.0.0.1:${tlsPort}`,
        certPath: defaultCert.certPath,
        keyPath: defaultCert.keyPath,
      }],
    })
    await sleep(600)
  })

  after(async () => {
    try {
      server?.stop()
    } catch {
      // ok
    }
    cleanups.forEach((fn) => fn())
  })

  it('serves the listener static cert for an unknown SNI (no global default yet)', async () => {
    assert.strictEqual(await getServedCN('unknown.test'), 'default.local')
  })

  it('serves an exact-match cert', async () => {
    server.updateCert('api.example.com', { certPem: certPem(apiCert), keyPem: keyPem(apiCert) })
    assert.strictEqual(await getServedCN('api.example.com'), 'api.example.com')
  })

  it('serves a wildcard cert for a one-label subdomain only', async () => {
    server.updateCert('*.example.com', {
      certPem: certPem(wildcardCert),
      keyPem: keyPem(wildcardCert),
    })

    assert.strictEqual(await getServedCN('www.example.com'), '*.example.com')
    // `*.example.com` must NOT match a two-label subdomain
    assert.strictEqual(await getServedCN('a.b.example.com'), 'default.local')
  })

  it('serves a deeper multi-level wildcard for its immediate parent only', async () => {
    server.updateCert('*.b.example.com', {
      certPem: certPem(multiWildcardCert),
      keyPem: keyPem(multiWildcardCert),
    })

    // `*.b.example.com` covers exactly one label below `b.example.com`
    assert.strictEqual(await getServedCN('a.b.example.com'), '*.b.example.com')
    // one more label falls through neither wildcard and hits the static cert
    assert.strictEqual(await getServedCN('x.a.b.example.com'), 'default.local')
  })

  it('hot-updates an exact cert on the next handshake', async () => {
    server.updateCert('api.example.com', {
      certPem: certPem(apiCert2),
      keyPem: keyPem(apiCert2),
    })
    assert.strictEqual(await getServedCN('api.example.com'), 'api2.example.com')
  })

  it('rejects a cert whose SAN/CN does not match the host', () => {
    assert.throws(
      () => server.updateCert('api.example.com', {
        certPem: certPem(wildcardCert),
        keyPem: keyPem(wildcardCert),
      }),
      /does not match/,
    )
  })

  it('allowMismatch bypasses the SAN/CN check', async () => {
    server.updateCert('api.example.com', {
      certPem: certPem(wildcardCert),
      keyPem: keyPem(wildcardCert),
      allowMismatch: true,
    })
    assert.strictEqual(await getServedCN('api.example.com'), '*.example.com')
  })

  it("updateCert('*') replaces the global default", async () => {
    server.updateCert('*', { certPem: certPem(globalCert), keyPem: keyPem(globalCert) })
    assert.strictEqual(await getServedCN('unknown.test'), 'global2.local')
  })

  it('removeCert(exact) falls back to the wildcard', async () => {
    assert.strictEqual(server.removeCert('api.example.com'), true)
    assert.strictEqual(await getServedCN('api.example.com'), '*.example.com')
  })

  it("removeCert('*.example.com') falls back to the global default", async () => {
    assert.strictEqual(server.removeCert('*.example.com'), true)
    assert.strictEqual(await getServedCN('api.example.com'), 'global2.local')
  })

  it("removeCert('*') falls back to the listener static cert", async () => {
    assert.strictEqual(server.removeCert('*'), true)
    assert.strictEqual(await getServedCN('unknown.test'), 'default.local')
  })

  it('rejects a TLS listener without a static cert when no global default is set', () => {
    const s = new LonesomeServer()
    assert.throws(
      () => s.start({ listeners: [{ kind: 'tls', addr: '127.0.0.1:1' }] }),
      /updateCert\('\*'\)/,
    )
  })

  it("allows a cert-less TLS listener once updateCert('*') has set a global default", async () => {
    const s = new LonesomeServer()
    s.updateCert('*', { certPem: certPem(globalCert), keyPem: keyPem(globalCert) })
    const port = await pickFreePort()
    s.start({ listeners: [{ kind: 'tls', addr: `127.0.0.1:${port}` }] })
    await sleep(600)

    assert.strictEqual(await getServedCNOn(port, 'whatever.test'), 'global2.local')
    try {
      s.stop()
    } catch {
      // ok
    }
  })
})
