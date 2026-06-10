import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startProxy } from "./helpers/proxy.js";
import { createUnixDynamicUpstream } from "./helpers/unix-upstream.js";
import { nextRouteId, withRoute } from "./helpers/routes.js";
import { assertStatus, getJson } from "./helpers/request.js";
import type { LonesomeServer, UpstreamConfig } from "../dist/index.js";

let server: LonesomeServer;
let proxyPort: number;
const upstreamA = createUnixDynamicUpstream();
const upstreamB = createUnixDynamicUpstream();
let cleanupRoundRobin: () => void;
let cleanupDefaultLb: () => void;

before(async () => {
  await upstreamA.start();
  await upstreamB.start();
  ({ server, port: proxyPort } = await startProxy());

  const upstreams: UpstreamConfig[] = [upstreamA.path, upstreamB.path].map(
    (path) => ({
      kind: "unix",
      address: path,
      tls: false,
      sni: "",
      weight: 1,
    }),
  );

  cleanupRoundRobin = withRoute(server, {
    id: nextRouteId("unix-lb"),
    matcher: { rule: "PathPrefix('/unix-lb')", priority: 10 },
    middlewares: [],
    upstreams,
    loadBalancer: { algorithm: "round_robin" },
  });

  cleanupDefaultLb = withRoute(server, {
    id: nextRouteId("unix-lb-default"),
    matcher: { rule: "PathPrefix('/unix-default')", priority: 10 },
    middlewares: [],
    upstreams,
  });
});

after(async () => {
  cleanupRoundRobin();
  cleanupDefaultLb();
  server.stop();
  await upstreamA.stop();
  await upstreamB.stop();
});

describe("unix upstream load balancing", () => {
  it("returns 502 for multiple Unix socket upstreams with the default consistent_hash LB", async () => {
    // Default multi-upstream LB is configured in src/upstream/upstream.rs:92.
    // It currently chooses consistent_hash, but Pingora Ketama ignores UDS backends:
    // See also Pingora source: pingora-load-balancing/src/selection/consistent.rs:42-46
    await assertStatus(proxyPort, "/unix-default/hello?x=1", 502);
  });

  it("proxies to one of multiple Unix socket upstreams with explicit round_robin", async () => {
    const { res, body } = await getJson(proxyPort, "/unix-lb/hello?x=1");

    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.url, "/unix-lb/hello?x=1");
    assert.strictEqual(body.method, "GET");
  });
});
