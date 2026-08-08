import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { startProxy } from './helpers/proxy.js'
import { nextRouteId, withRoute } from './helpers/routes.js'
import { proxyFetch } from './helpers/request.js'
import { generateMtlsFixtures, hasOpenssl } from './helpers/tls.js'
import type { LonesomeServer, UpstreamConfig } from '../dist/index.js'

const skipWithoutOpenssl = {
  skip: hasOpenssl() ? false : 'requires openssl CLI (not available on this host)',
}

describe('upstream mTLS', skipWithoutOpenssl, () => {
  let server: LonesomeServer
  let proxyPort: number
  let tlsPort: number
  let tlsUpstream: https.Server
  let fixtures: ReturnType<typeof generateMtlsFixtures>

  before(async () => {
    fixtures = generateMtlsFixtures()
    tlsUpstream = https.createServer(
      {
        key: fixtures.serverKeyPem,
        cert: fixtures.serverCertPem,
        requestCert: true,
        rejectUnauthorized: true,
        ca: [fixtures.caCertPem],
      },
      (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ authorized: (_req.socket as TLSSocket).authorized }))
      },
    )
    await new Promise<void>((resolve) => tlsUpstream.listen(0, '127.0.0.1', resolve))
    tlsPort = (tlsUpstream.address() as AddressInfo).port
    ;({ server, port: proxyPort } = await startProxy())
  })

  after(async () => {
    try {
      server?.stop()
    } catch {
      // ok
    }
    await new Promise<void>((resolve) => tlsUpstream.close(() => resolve()))
    fixtures.cleanup()
  })

  function upstreamConfig(overrides: Partial<UpstreamConfig> = {}): UpstreamConfig {
    return {
      kind: 'tcp',
      address: `127.0.0.1:${tlsPort}`,
      tls: true,
      sni: '127.0.0.1',
      verifyCert: false,
      weight: 1,
      ...overrides,
    }
  }

  it('fails when the upstream requires a client certificate and none is configured', async () => {
    const clean = withRoute(server, {
      id: nextRouteId('mtls-none'),
      matcher: { rule: "PathPrefix('/mtls/none')", priority: 50 },
      middlewares: [],
      upstreams: [upstreamConfig()],
    })

    let status = 0
    try {
      const res = await proxyFetch(proxyPort, '/mtls/none')
      status = res.status
      await res.text().catch(() => {})
    } catch {
      status = 0
    }
    assert.notStrictEqual(status, 200, `expected an mTLS handshake failure, got ${status}`)
    clean()
  })

  it('presents the configured client certificate to the upstream', async () => {
    const clean = withRoute(server, {
      id: nextRouteId('mtls-present'),
      matcher: { rule: "PathPrefix('/mtls/present')", priority: 50 },
      middlewares: [],
      upstreams: [upstreamConfig({
        clientCertPem: fixtures.clientCertPem,
        clientKeyPem: fixtures.clientKeyPem,
      })],
    })

    const res = await proxyFetch(proxyPort, '/mtls/present')
    const body = JSON.parse(await res.text())
    assert.strictEqual(res.status, 200)
    assert.strictEqual(body.authorized, true)
    clean()
  })

  it('rejects a client cert without its key at validation', () => {
    assert.throws(
      () => {
        server.validate({
          id: nextRouteId('mtls-invalid'),
          matcher: { rule: "PathPrefix('/mtls/invalid')", priority: 50 },
          middlewares: [],
          upstreams: [upstreamConfig({ clientCertPem: fixtures.clientCertPem })],
        })
      },
      /client_cert_pem/,
    )
  })
})
