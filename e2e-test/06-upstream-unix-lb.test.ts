import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startProxy } from "./helpers/proxy.js";
import { createUnixDynamicUpstream } from "./helpers/unix-upstream.js";
import { nextRouteId, withRoute } from "./helpers/routes.js";
import { proxyFetch } from "./helpers/request.js";
import type { LonesomeServer, UpstreamConfig } from "../dist/index.js";

let server: LonesomeServer;
let proxyPort: number;
const upstreamA = createUnixDynamicUpstream();
const upstreamB = createUnixDynamicUpstream();
let cleanupRoundRobin: () => void
let cleanupConsistentHash: () => void
const consistentRouteId = nextRouteId('unix-lb-consistent')

function unixUpstreams(): UpstreamConfig[] {
  return [upstreamA.path, upstreamB.path].map((path) => ({
    kind: 'unix',
    address: path,
    tls: false,
    sni: '',
    weight: 1,
  }))
}

before(async () => {
  await upstreamA.start();
  await upstreamB.start();
  ({ server, port: proxyPort } = await startProxy());

  upstreamA.setHandler((_req, res) => {
    res.setHeader('x-from', 'a')
    res.end('a')
  })
  upstreamB.setHandler((_req, res) => {
    res.setHeader('x-from', 'b')
    res.end('b')
  })

  cleanupRoundRobin = withRoute(server, {
    id: nextRouteId("unix-lb"),
    matcher: { rule: "PathPrefix('/unix-lb')", priority: 10 },
    middlewares: [],
    upstreams: unixUpstreams(),
    loadBalancer: { algorithm: "round_robin" },
  });

  cleanupConsistentHash = withRoute(server, {
    id: consistentRouteId,
    matcher: { rule: "PathPrefix('/unix-consistent')", priority: 10 },
    middlewares: [],
    upstreams: unixUpstreams(),
    loadBalancer: {
      algorithm: 'consistent_hash',
      maxIterations: 32,
      hashKeyRule: "HeaderValue('x-user')",
    },
  });
});

after(async () => {
  cleanupRoundRobin();
  cleanupConsistentHash();
  server.stop();
  await upstreamA.stop();
  await upstreamB.stop();
});

describe("unix upstream load balancing", () => {
  it('routes the same hash key consistently across Unix socket upstreams', async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 8; i++) {
      const res = await proxyFetch(proxyPort, '/unix-consistent/hello?x=1', {
        headers: { 'x-user': 'alice' },
      })
      await res.text()
      assert.strictEqual(res.status, 200)
      seen.add(res.headers.get('x-from') ?? '')
    }

    assert.strictEqual(seen.size, 1, `expected one Unix upstream, got ${Array.from(seen).join(',')}`)
  })

  it('keeps Unix consistent-hash ownership when a route reload reorders upstreams', async () => {
    const keys = Array.from({ length: 24 }, (_, i) => `user-${i}`)
    const before = new Map<string, string>()

    for (const key of keys) {
      const res = await proxyFetch(proxyPort, '/unix-consistent/reload', {
        headers: { 'x-user': key },
      })
      await res.text()
      assert.strictEqual(res.status, 200)
      before.set(key, res.headers.get('x-from') ?? '')
    }

    server.addOrUpdate({
      id: consistentRouteId,
      matcher: { rule: "PathPrefix('/unix-consistent')", priority: 10 },
      middlewares: [],
      upstreams: [...unixUpstreams()].reverse(),
      loadBalancer: {
        algorithm: 'consistent_hash',
        maxIterations: 32,
        hashKeyRule: "HeaderValue('x-user')",
      },
    })

    for (const key of keys) {
      const res = await proxyFetch(proxyPort, '/unix-consistent/reload', {
        headers: { 'x-user': key },
      })
      await res.text()
      assert.strictEqual(res.status, 200)
      assert.strictEqual(
        res.headers.get('x-from') ?? '',
        before.get(key),
        `hash key '${key}' changed owner after a reorder-only route reload`,
      )
    }
  });

  it("proxies to one of multiple Unix socket upstreams with explicit round_robin", async () => {
    const res = await proxyFetch(proxyPort, "/unix-lb/hello?x=1")
    await res.text()

    assert.strictEqual(res.status, 200);
    assert.strictEqual(['a', 'b'].includes(res.headers.get('x-from') ?? ''), true);
  });
});
