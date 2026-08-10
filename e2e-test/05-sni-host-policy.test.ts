import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { LonesomeServer } from '../dist/index.js'
import type { LonesomeServer as LonesomeServerType } from '../dist/index.js'
import { createDynamicUpstream } from './helpers/upstream.js'
import { nextRouteId, tcpUpstream, withRoute } from './helpers/routes.js'
import { requestRawHttps } from './helpers/request.js'
import { pickFreePort, sleep } from './helpers/proxy.js'
import { generateSelfSignedTlsCert, hasOpenssl } from './helpers/tls.js'
import { conditionalDescribe } from './helpers/conditional_describe.js'

const skipWithoutOpenssl = hasOpenssl() ? false : 'requires openssl CLI (not available on this host)'

type SniHostPolicy = 'loose_by_sni' | 'loose_by_header' | 'strict' | 'strict_rewrite_header'

/**
 * Send an HTTPS request with an SNI that may differ from the Host header.
 * Returns { status, hostSeen, upstreamUrl } where hostSeen is the `host`
 * header the upstream actually received (via the echo handler).
 */
async function httpsWithSni(
  port: number,
  sni: string,
  host: string,
): Promise<{ status: number; hostSeen: string; upstreamUrl: string }> {
  const agent = new https.Agent({ rejectUnauthorized: false })
  const { response, body } = await requestRawHttps(port, '/probe', {
    agent,
    servername: sni,
    headers: { host },
  })
  const text = body.toString('utf8')
  let payload: any = {}
  try {
    payload = JSON.parse(text)
  } catch {
    // non-JSON (e.g. error page)
  }
  return {
    status: response.statusCode ?? 0,
    hostSeen: String(payload?.headers?.host ?? ''),
    upstreamUrl: String(payload?.url ?? ''),
  }
}

conditionalDescribe('sniHostPolicy', skipWithoutOpenssl, () => {
  async function startPolicyServer(policy: SniHostPolicy): Promise<{
    port: number
    upstreamA: ReturnType<typeof createDynamicUpstream>
    upstreamB: ReturnType<typeof createDynamicUpstream>
    stop: () => void
  }> {
    const upstreamA = createDynamicUpstream()
    const upstreamB = createDynamicUpstream()
    await upstreamA.start()
    await upstreamB.start()

    const port = await pickFreePort()
    const cert = generateSelfSignedTlsCert('a.example.com')
    const server = new LonesomeServer()
    server.start({
      listeners: [{
        kind: 'tls',
        addr: `127.0.0.1:${port}`,
        certPath: cert.certPath,
        keyPath: cert.keyPath,
      }],
      sniHostPolicy: policy,
    })
    await sleep(600)

    const cleanups = [
      withRoute(server, {
        id: nextRouteId('sni-host-a'),
        matcher: { rule: "Host('a.example.com')", priority: 60 },
        middlewares: [],
        upstreams: tcpUpstream(upstreamA.port),
      }),
      withRoute(server, {
        id: nextRouteId('sni-host-b'),
        matcher: { rule: "Host('b.example.com')", priority: 60 },
        middlewares: [],
        upstreams: tcpUpstream(upstreamB.port),
      }),
    ]

    return {
      port,
      upstreamA,
      upstreamB,
      stop: () => {
        cleanups.forEach((fn) => fn())
        try {
          server.stop()
        } catch {
          // ok
        }
        cert.cleanup()
        upstreamA.stop()
        upstreamB.stop()
      },
    }
  }

  describe('strict (default)', () => {
    let fixture: Awaited<ReturnType<typeof startPolicyServer>>
    before(async () => {
      fixture = await startPolicyServer('strict')
    })
    after(() => fixture?.stop())

    it('rejects a request whose SNI differs from the Host header with 421', async () => {
      const { status, hostSeen } = await httpsWithSni(fixture.port, 'a.example.com', 'b.example.com')
      assert.strictEqual(status, 421)
      assert.strictEqual(hostSeen, '')
    })

    it('forwards a matching SNI/Host pair to the SNI-selected route', async () => {
      const { status, hostSeen, upstreamUrl } = await httpsWithSni(
        fixture.port,
        'a.example.com',
        'a.example.com',
      )
      assert.strictEqual(status, 200)
      assert.strictEqual(hostSeen, 'a.example.com')
      assert.strictEqual(upstreamUrl, '/probe')
    })
  })

  describe('loose_by_sni', () => {
    let fixture: Awaited<ReturnType<typeof startPolicyServer>>
    before(async () => {
      fixture = await startPolicyServer('loose_by_sni')
    })
    after(() => fixture?.stop())

    it('routes by SNI but forwards the mismatched Host verbatim', async () => {
      const { status, hostSeen, upstreamUrl } = await httpsWithSni(
        fixture.port,
        'a.example.com',
        'b.example.com',
      )
      assert.strictEqual(status, 200)
      assert.strictEqual(upstreamUrl, '/probe')
      // routed to upstream A (SNI a.example.com) but upstream saw Host b.example.com
      assert.strictEqual(hostSeen, 'b.example.com')
    })
  })

  describe('loose_by_header', () => {
    let fixture: Awaited<ReturnType<typeof startPolicyServer>>
    before(async () => {
      fixture = await startPolicyServer('loose_by_header')
    })
    after(() => fixture?.stop())

    it('routes by the Host header and forwards it verbatim', async () => {
      const { status, hostSeen, upstreamUrl } = await httpsWithSni(
        fixture.port,
        'a.example.com',
        'b.example.com',
      )
      assert.strictEqual(status, 200)
      assert.strictEqual(upstreamUrl, '/probe')
      // routed by Host b.example.com -> upstream B saw Host b.example.com
      assert.strictEqual(hostSeen, 'b.example.com')
    })
  })

  describe('strict_rewrite_header', () => {
    let fixture: Awaited<ReturnType<typeof startPolicyServer>>
    before(async () => {
      fixture = await startPolicyServer('strict_rewrite_header')
    })
    after(() => fixture?.stop())

    it('routes by SNI and rewrites the forwarded Host to the SNI', async () => {
      const { status, hostSeen, upstreamUrl } = await httpsWithSni(
        fixture.port,
        'a.example.com',
        'b.example.com',
      )
      assert.strictEqual(status, 200)
      assert.strictEqual(upstreamUrl, '/probe')
      // routed to upstream A (SNI a.example.com) and the Host was rewritten
      assert.strictEqual(hostSeen, 'a.example.com')
    })
  })

  describe('status() reports the policy', () => {
    let server: LonesomeServerType
    let port: number
    before(async () => {
      port = await pickFreePort()
      const cert = generateSelfSignedTlsCert('default.local')
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
      cert.cleanup()
    })
    after(() => {
      try {
        server?.stop()
      } catch {
        // ok
      }
    })

    it('defaults to strict', () => {
      assert.strictEqual(server.status().sniHostPolicy, 'strict')
    })
  })
})
