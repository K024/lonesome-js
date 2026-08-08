# Documentation Index

This document is the entry point for the `lonesome-js` docs set.

## LonesomeServer Control API

`LonesomeServer` provides runtime control for startup, route management, and process status.

```ts
class LonesomeServer {
  start(startup: StartupConfig): void
  stop(): void
  validate(route: RouteConfig): void
  addOrUpdate(route: RouteConfig): void
  remove(routeId: string): boolean
  status(): ServerStatus
  updateCert(host: string, options: UpdateCertOptions): void
  removeCert(host: string): boolean
}
```

### `start(startup)`

Starts the proxy service.

```ts
server.start({
  listeners: [{ kind: 'tcp', addr: '127.0.0.1:8080' }],
})
```

Notes:
- Must be called before route traffic handling.
- Listener definitions come from `StartupConfig.listeners`.

### `stop()`

Stops the running proxy service.

```ts
server.stop()
```

Notes:
- Safe to call during controlled shutdown.
- Existing in-flight request behavior depends on runtime state and transport lifecycle.

### `validate(route)`

Validates a route without registering or replacing it. It uses the same path as
`addOrUpdate`, including route structure checks, CEL compilation, middleware
construction, and upstream/load-balancer validation.

```ts
server.validate({
  id: 'api-main',
  matcher: { rule: "PathPrefix('/api')" },
  middlewares: [],
  upstreams: [{ kind: 'tcp', address: '127.0.0.1:9000' }],
})
```

Use this to fail fast before applying a route update. A successful call does
not change `status().routeCount` or affect traffic.

### `addOrUpdate(route)`

Creates a route when `route.id` is new, or hot-updates the route when the same `id` already exists.

```ts
server.addOrUpdate({
  id: 'api-main',
  matcher: { rule: "PathPrefix('/api')", priority: 50 },
  middlewares: [],
  upstreams: [{ kind: 'tcp', address: '127.0.0.1:9000' }],
})
```

### `remove(routeId)`

Removes a route by `id`.

```ts
const removed = server.remove('api-main')
```

Return value:
- `true`: route existed and was removed.
- `false`: route did not exist.

### `status()`

Returns a read-only snapshot of the running proxy: runtime configuration,
registered routes and their upstreams, and (when the `health_check` middleware
is active on a route) passive upstream health. It never measures traffic.

```ts
const st = server.status()
// {
//   running, routeCount, threads, workStealing,
//   listeners: [{ kind, addr }],
//   routes: [{ id, rule, priority, loadBalancer, upstreams: [{ kind, address, weight, health? }] }],
// }
```

See [tls.md](./tls.md) for dynamic TLS certificates and the cert-less listener.

## TLS Certificates

TLS certificates are managed in two layers:

- **Static (acceptor)**: the TLS listener's `certPath`/`keyPath` from `start()`
  are the lowest-priority default and are fixed for the process lifetime.
- **Runtime (cert store)**: `updateCert()` registers certificates keyed by
  hostname and takes effect on the next handshake, without restarting.

```ts
// exact host
server.updateCert('api.example.com', { certPem, keyPem })
// one-label wildcard (matches www.example.com, not a.b.example.com)
server.updateCert('*.example.com', { certPem, keyPem })
// global default (overrides the listener's static cert)
server.updateCert('*', { certPem, keyPem })
// skip the SAN/CN hostname match check
server.updateCert('example.com', { certPem, keyPem, allowMismatch: true })
server.removeCert('*.example.com')
```

A TLS listener may also be started **without** `certPath`/`keyPath`; in that case
a global default must already have been set via `updateCert('*')`, otherwise
`start()` throws. See [tls.md](./tls.md).

## Type References

```ts
interface StartupConfig {
  threads?: number
  workStealing?: boolean
  listeners: StartupListenerConfig[]
}

interface StartupListenerConfig {
  kind: 'tcp' | 'tls' | 'unix'
  addr: string
  // TLS cert paths are optional: a cert-less TLS listener requires a global
  // default set via updateCert('*') before start().
  certPath?: string
  keyPath?: string
}

interface UpdateCertOptions {
  certPem: string
  keyPem: string
  // Skip the SAN/CN hostname match check (default false).
  allowMismatch?: boolean
}

interface ServerStatus {
  running: boolean
  routeCount: number
  threads: number
  workStealing: boolean
  listeners: Array<{ kind: string; addr: string }>
  routes: Array<{
    id: string
    rule: string
    priority: number
    loadBalancer: { algorithm: string; maxIterations: number; hashKeyRule?: string }
    upstreams: Array<{
      kind: string
      address: string
      weight: number
      health?: { healthy: boolean; tolerance: number }
    }>
  }>
}
```

For complete route and upstream typing details, see the linked docs below.

## Related Documents

- Route management and hot updates: [route.md](./route.md)
- Dynamic TLS certificates: [tls.md](./tls.md)
- CEL expressions and runtime evaluation: [cel.md](./cel.md)
- In-process JS upstreams: [virtual_js.md](./virtual_js.md)
- JavaScript request interceptors: [interceptor.md](./interceptor.md)
- Middleware reference: [middlewares/readme.md](./middlewares/readme.md)
