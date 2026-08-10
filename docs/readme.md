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
  updateErrorPage(options: ErrorPageOptions): void
  removeErrorPage(id: string): boolean
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
//   running, routeCount, threads, workStealing, sniHostPolicy, errorPageCount,
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

## SNI / Host Policy

`sniHostPolicy` (startup option, default `'strict'`) controls how the TLS SNI
and the HTTP-level authority (`:authority` / `Host` header) relate for routing
and forwarding. A client controls both independently, and a mismatch is the
mechanism behind domain fronting and upstream vhost confusion.

| value | routing host | on SNI ≠ HTTP authority | on `:authority` ≠ `Host` |
|---|---|---|---|
| `loose_by_sni` | SNI, then authority | forwarded verbatim | authority wins |
| `loose_by_header` | HTTP authority | forwarded verbatim | authority wins |
| `strict` (default) | HTTP authority | **421 Misdirected Request** | **400** |
| `strict_rewrite_header` | SNI, then authority | forwarded authority rewritten to SNI | **400** |

Details:

- **`strict`** rejects a request whose SNI differs from its HTTP authority with
  `421 Misdirected Request`. A request carrying both `:authority` and a `Host`
  header that disagree is malformed per RFC 9113 §8.3.1 and rejected with
  `400`. This is the Apache ≥2.4.64 behavior.
- **`strict_rewrite_header`** keeps the request but forces the authority sent
  to the upstream (both the `Host` header for the HTTP/1.1 hop and
  `:authority` for the HTTP/2 hop) to the SNI, so an upstream doing vhost
  routing can never see a mismatched value (nginx
  `proxy_set_header Host $ssl_server_name` style).
- **`loose_by_sni`** is the historical behavior. **`loose_by_header`** routes
  purely on the HTTP authority (Caddy/Envoy style).
- Hostnames are compared case-insensitively with any trailing dot ignored.
  When both `:authority` and `Host` are present, `:authority` determines the
  target URI per RFC 9113.
- The routing host is also what `Host()` / `HostValue()` see in CEL. The raw
  inputs are available as `SniValue()` and `AuthorityValue()`; see
  [cel.md](./cel.md).

```ts
server.start({
  listeners: [{ kind: 'tls', addr: '127.0.0.1:443', certPath, keyPath }],
  sniHostPolicy: 'strict_rewrite_header',
})
```

## Error Pages

`updateErrorPage` / `removeErrorPage` control the responses served for
**generated** error statuses (>= 400): the SNI/Host policy gate (400/421),
proxy failures (404/502/...), and the error-producing middlewares (`jwt`,
`basic_auth`, `rate_limit`, and a bare `respond` error status). Upstream content
and explicit middleware bodies (e.g. `respond.body`) are never overridden.
Pages are hot-updated at runtime; reads are lock-free snapshots.

```ts
server.updateErrorPage({
  id: 'maintenance',
  status: '502-504',           // number | string spec: 400-403,418,500
  matcher: "PathPrefix('/api')", // optional CEL rule; page applies only when it matches
  priority: 10,                  // higher wins; ties keep insertion order
  statusOverride: 200,           // optional: serve with a different status
  body: 'Service temporarily unavailable',
  contentType: 'text/html; charset=utf-8',
  headers: { 'Retry-After': '120' },
})
server.removeErrorPage('maintenance')
```

Semantics:

- Entries are keyed by `id` (upsert). Omit `status` to serve any generated
  error status. `status` accepts a single code or a spec like `"400-403,418"`.
- Among entries whose status applies, the first whose `matcher` evaluates to
  true wins; a page without a matcher is unconditional.
- Body may be a static `body` or a CEL `bodyExpression` (scalar result), which
  can reference `ErrorStatusValue()` (the status being served), `HostValue()`,
  `PathValue()`, `HeaderValue(...)`, `ClientIPValue()`, etc.
- When no page matches, the built-in empty error response is served.
- The page count is reported as `status().errorPageCount`.

See [cel.md](./cel.md) for the CEL functions available in matchers and body
expressions.

## Type References

```ts
interface StartupConfig {
  threads?: number
  workStealing?: boolean
  listeners: StartupListenerConfig[]
  // How TLS SNI and the HTTP authority (:authority / Host header) relate.
  // Default 'strict'. See "SNI / Host Policy" above.
  sniHostPolicy?: 'loose_by_sni' | 'loose_by_header' | 'strict' | 'strict_rewrite_header'
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

interface ErrorPageOptions {
  id: string
  // Single code or a comma-separated spec with ranges, e.g. '400-403,418,500'.
  // Omit to serve any generated error status.
  status?: number | string
  // Optional CEL rule; the page is used only when it evaluates to true.
  matcher?: string
  body?: string
  // CEL scalar expression; mutually exclusive with `body`.
  bodyExpression?: string
  contentType?: string
  headers?: Record<string, string>
  // Serve with a different status than the generated one.
  statusOverride?: number
  priority?: number
}

interface ServerStatus {
  running: boolean
  routeCount: number
  threads: number
  workStealing: boolean
  sniHostPolicy: 'loose_by_sni' | 'loose_by_header' | 'strict' | 'strict_rewrite_header'
  errorPageCount: number
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
