# Documentation Index

This document is the entry point for the `lonesome-js` docs set.

## LonesomeServer Control API

`LonesomeServer` provides runtime control for startup, route management, and process status.

```ts
class LonesomeServer {
  start(startup: StartupConfig): void
  stop(): void
  addOrUpdate(route: RouteConfig): void
  remove(routeId: string): boolean
  status(): ServerStatus
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

Returns runtime status summary.

```ts
const st = server.status()
// { running: boolean, routeCount: number }
```

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
  certPath?: string
  keyPath?: string
}

interface ServerStatus {
  running: boolean
  routeCount: number
}
```

For complete route and upstream typing details, see the linked docs below.

## Related Documents

- Route management and hot updates: [route.md](./route.md)
- CEL expressions and runtime evaluation: [cel.md](./cel.md)
- In-process JS upstreams: [virtual_js.md](./virtual_js.md)
