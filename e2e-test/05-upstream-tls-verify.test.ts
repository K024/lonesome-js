import { it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { startProxy } from './helpers/proxy.js'
import { nextRouteId, withRoute } from './helpers/routes.js'
import { proxyFetch } from './helpers/request.js'
import { generateSelfSignedTlsCert, hasOpenssl } from './helpers/tls.js'
import { conditionalDescribe } from './helpers/conditional_describe.js'
import type { LonesomeServer, UpstreamConfig } from '../dist/index.js'

const skipWithoutOpenssl = hasOpenssl() ? false : 'requires openssl CLI (not available on this host)'

conditionalDescribe('upstream TLS verification', skipWithoutOpenssl, () => {
  let server: LonesomeServer
  let proxyPort: number
  let tlsPort: number
  let tlsUpstream: https.Server
  let cert: ReturnType<typeof generateSelfSignedTlsCert>

  before(async () => {
    cert = generateSelfSignedTlsCert('127.0.0.1')
    const key = readFileSync(cert.keyPath)
    const certPem = readFileSync(cert.certPath)
    tlsUpstream = https.createServer({ key, cert: certPem }, (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
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
    cert.cleanup()
  })

  function tlsUpstreamConfig(overrides: Partial<UpstreamConfig> = {}): UpstreamConfig {
    return {
      kind: 'tcp',
      address: `127.0.0.1:${tlsPort}`,
      tls: true,
      sni: '127.0.0.1',
      weight: 1,
      ...overrides,
    }
  }

  it('rejects a self-signed upstream when verification is enabled (default)', async () => {
    const clean = withRoute(server, {
      id: nextRouteId('tlsv-verify'),
      matcher: { rule: "PathPrefix('/tlsv/verify')", priority: 50 },
      middlewares: [],
      upstreams: [tlsUpstreamConfig()],
    })

    let status = 0
    try {
      const res = await proxyFetch(proxyPort, '/tlsv/verify')
      status = res.status
      await res.text().catch(() => {})
    } catch {
      status = 0
    }
    assert.notStrictEqual(status, 200, `expected a verification failure, got ${status}`)
    clean()
  })

  it('accepts a self-signed upstream with verifyCert=false', async () => {
    const clean = withRoute(server, {
      id: nextRouteId('tlsv-noverify'),
      matcher: { rule: "PathPrefix('/tlsv/noverify')", priority: 50 },
      middlewares: [],
      upstreams: [tlsUpstreamConfig({ verifyCert: false })],
    })

    const res = await proxyFetch(proxyPort, '/tlsv/noverify')
    await res.text()
    assert.strictEqual(res.status, 200)
    clean()
  })
})
