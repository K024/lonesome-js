# Route Management

This document covers route lifecycle and hot-update behavior.

## Route Shape

`addOrUpdate` accepts the following structure:

```ts
{
  id: string,
  matcher: {
    rule: string,
    priority?: number,
  },
  middlewares: Array<{ type: string; config: any }>,
  upstreams: Array<{
    kind?: 'tcp' | 'unix' | 'virtual_js',
    address: string,
    tls?: boolean,
    h2c?: boolean,
    sni?: string,
    weight?: number,
    connectTimeoutMs?: number,
    readTimeoutMs?: number,
    writeTimeoutMs?: number,
    idleTimeoutMs?: number,
    verifyCert?: boolean,
    clientCertPem?: string,
    clientKeyPem?: string,
    caCertPem?: string,
  }>,
  loadBalancer?: {
    algorithm?: 'round_robin' | 'rr' | 'consistent_hash' | 'consistent' | 'ch',
    maxIterations?: number,
    hashKeyRule?: string,
  },
}
```

## Lifecycle API

```ts
const server = new LonesomeServer()

server.start({ listeners: [{ kind: 'tcp', addr: '127.0.0.1:8080' }] })

server.validate(routeConfig)

server.addOrUpdate(routeConfig)

const removed = server.remove(routeId)

const st = server.status() // { running, routeCount, threads, listeners, routes, ... }

server.stop()
```

## Upstream Options

Per-upstream networking tunables:

| field | meaning | default |
|---|---|---|
| `connectTimeoutMs` | TCP/TLS connect timeout in ms | no explicit timeout |
| `readTimeoutMs` | timeout for reading from the upstream in ms | no explicit timeout |
| `writeTimeoutMs` | timeout for writing to the upstream in ms | no explicit timeout |
| `idleTimeoutMs` | idle timeout for pooled upstream connections in ms | no explicit timeout |
| `verifyCert` | verify the upstream TLS certificate | `true` |
| `clientCertPem` | PEM client certificate presented to the upstream (mTLS) | none |
| `clientKeyPem` | PEM private key for `clientCertPem` | none |
| `caCertPem` | PEM CA bundle used to verify the upstream certificate | system store |

`clientCertPem` and `clientKeyPem` must be provided together. Set
`verifyCert: false` when proxying to a self-signed or otherwise untrusted TLS
upstream. Together with `clientCertPem`/`clientKeyPem` and `caCertPem`, this
enables full mutual TLS against an upstream that verifies the presented client
certificate.

## Load Balancer Notes

When a route has more than one upstream and no `loadBalancer` is provided,
`lonesome-js` currently defaults to `consistent_hash`. TCP upstreams use their
actual network addresses. Unix socket and `virtual_js` upstreams use stable,
internal synthetic IPv6 identities under RFC 3849's `2001:db8::/32`
documentation range so that Pingora's Ketama selector can include them.

These synthetic addresses are never connected to; after selection,
`lonesome-js` maps the backend back to the configured Unix path or virtual JS
key. Reordering unchanged Unix or `virtual_js` upstreams during a route update
therefore retains their consistent-hash identities.

For example, multiple Unix socket upstreams can use consistent hashing:

```ts
server.addOrUpdate({
  id: 'uds-workers',
  matcher: { rule: "PathPrefix('/uds')" },
  middlewares: [],
  upstreams: [
    { kind: 'unix', address: '/tmp/worker-a.sock' },
    { kind: 'unix', address: '/tmp/worker-b.sock' },
  ],
  loadBalancer: {
    algorithm: 'consistent_hash',
    hashKeyRule: "HeaderValue('x-user')",
  },
})
```

## `addOrUpdate` Behavior

`addOrUpdate` handles both create and update:

- If `id` does not exist: create a new route.
- If `id` exists: replace that route in place.

The new config takes effect immediately without restarting the process.

## `validate` Behavior

`validate(routeConfig)` checks whether a route can be accepted without changing
the active route table. It runs the same configuration conversion and route
construction work as `addOrUpdate`, including:

- basic route, middleware, and upstream configuration checks;
- CEL compilation for the route matcher and configured CEL expressions;
- middleware construction; and
- upstream and load-balancer construction.

It throws when the route is invalid. A successful validation does not register
the route, replace an existing route, or alter `status().routeCount`.

```ts
server.validate({
  id: 'api-next',
  matcher: { rule: "PathPrefix('/api')" },
  middlewares: [],
  upstreams: [{ kind: 'tcp', address: '127.0.0.1:9000' }],
})
```

### Hot Update Example: Add `respond` to an existing route

```ts
// First write: regular proxying
server.addOrUpdate({
  id: 'mgmt-upd',
  matcher: { rule: "PathPrefix('/mgmt/upd')", priority: 50 },
  middlewares: [],
  upstreams: [{
    kind: 'tcp',
    address: '127.0.0.1:9000',
    tls: false,
    sni: '',
    weight: 1,
  }],
})

// Second write with the same id: switch to 418 short-circuit response
server.addOrUpdate({
  id: 'mgmt-upd',
  matcher: { rule: "PathPrefix('/mgmt/upd')", priority: 50 },
  middlewares: [{ type: 'respond', config: { status: 418, body: 'teapot' } }],
  upstreams: [{
    kind: 'tcp',
    address: '127.0.0.1:9000',
    tls: false,
    sni: '',
    weight: 1,
  }],
})
```

## `remove` Behavior

- Returns `true` when removing an existing route.
- Returns `false` for a non-existent route.
- Requests stop matching immediately after removal.

## `status` Behavior

`status()` returns a read-only snapshot of runtime configuration and the
registered route table:

```ts
{
  running: boolean,
  routeCount: number,
  threads: number,
  workStealing: boolean,
  listeners: Array<{ kind: string; addr: string }>,
  routes: Array<{
    id: string,
    rule: string,
    priority: number,
    loadBalancer: { algorithm: string, maxIterations: number, hashKeyRule?: string },
    upstreams: Array<{
      kind: string,
      address: string,
      weight: number,
      health?: { healthy: boolean, tolerance: number },
    }>,
  }>,
}
```

Meaning:

- `running`: whether the server is started.
- `routeCount`: number of routes currently registered in memory.
- `threads` / `workStealing`: the startup runtime configuration.
- `listeners`: the configured listeners.
- `routes`: each registered route with its resolved upstreams.
- `upstreams[].health`: present only when the route is served by a
  `health_check` middleware that has observed traffic; otherwise absent.

`status()` never measures traffic; request counters and latency are the
responsibility of the application layer.

## Practical Recommendations

- Keep route `id` stable and readable for safe hot updates.
- Middleware order is execution order; changing order changes behavior.
- In automation, use `status().routeCount` to verify route orchestration.
- For production updates, use a consistent route naming convention to reduce accidental overwrites.
