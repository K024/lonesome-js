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

server.addOrUpdate(routeConfig)

const removed = server.remove(routeId)

const st = server.status() // { running, routeCount }

server.stop()
```

## `addOrUpdate` Behavior

`addOrUpdate` handles both create and update:
- If `id` does not exist: create a new route.
- If `id` exists: replace that route in place.

The new config takes effect immediately without restarting the process.

### Hot Update Example: Add `respond` to an existing route

```ts
// First write: regular proxying
server.addOrUpdate({
  id: 'mgmt-upd',
  matcher: { rule: "PathPrefix('/mgmt/upd')", priority: 50 },
  middlewares: [],
  upstreams: [{ kind: 'tcp', address: '127.0.0.1:9000', tls: false, sni: '', weight: 1 }],
})

// Second write with the same id: switch to 418 short-circuit response
server.addOrUpdate({
  id: 'mgmt-upd',
  matcher: { rule: "PathPrefix('/mgmt/upd')", priority: 50 },
  middlewares: [{ type: 'respond', config: { status: 418, body: 'teapot' } }],
  upstreams: [{ kind: 'tcp', address: '127.0.0.1:9000', tls: false, sni: '', weight: 1 }],
})
```

## `remove` Behavior

- Returns `true` when removing an existing route.
- Returns `false` for a non-existent route.
- Requests stop matching immediately after removal.

## `status` Behavior

`status()` returns:

```ts
{
  running: boolean,
  routeCount: number,
}
```

Meaning:
- `running`: whether the server is started.
- `routeCount`: number of routes currently registered in memory.

## Practical Recommendations

- Keep route `id` stable and readable for safe hot updates.
- Middleware order is execution order; changing order changes behavior.
- In automation, use `status().routeCount` to verify route orchestration.
- For production updates, use a consistent route naming convention to reduce accidental overwrites.
