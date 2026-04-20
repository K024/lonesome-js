# lonesome-js

High-performance programmable reverse proxy bindings for Node.js, built on top of Pingora.

[中文文档 (README.zh.md)](./README.zh.md)

## Why lonesome-js

- Built on Pingora for modern async proxy performance and reliability.
- Runtime route updates (`addOrUpdate`) with Node.js without process restarts.
- Request matching and middleware conditions powered by CEL expressions.
- `virtual_js` upstream mode for in-process Node.js service composition.

## How It Differs From Traditional Reverse Proxies

Most reverse proxies focus on static config files and process-level reload workflows. `lonesome-js` is designed around a runtime API and programmable request flow.

### CEL-Driven Routing and Middleware Logic

Instead of limiting logic to fixed directives, routes and middleware conditions can use CEL expressions for matching and value generation.

Examples:
- Route match: `"Method('POST') && PathPrefix('/api') && Query('debug', '1')"`
- Conditional middleware: `rule: "Header('x-env', 'prod')"`
- Dynamic value: `expression: "MethodValue() + '-' + QueryValue('id')"`

### `virtual_js` Upstreams

Beyond TCP/Unix socket upstreams, `virtual_js` allows requests to be bridged into JavaScript handlers in-process. This makes it possible to build internal adapters and programmable backends without opening extra network ports.

## Quick Start

### 1. Install

```bash
npm i lonesome-js
```

> Windows prebuilt binding is temporarily unavailable; use WSL as a temporary workaround.

### 2. Start a proxy server

```ts
import { LonesomeServer } from 'lonesome-js'

const server = new LonesomeServer()

server.start({
  listeners: [{ kind: 'tcp', addr: '127.0.0.1:8080' }],
})
```

### 3. Add a basic route

```ts
server.addOrUpdate({
  id: 'basic-proxy',
  matcher: { rule: "PathPrefix('/api')", priority: 50 },
  middlewares: [],
  upstreams: [
    { kind: 'tcp', address: '127.0.0.1:9000' },
  ],
  loadBalancer: { algorithm: 'round_robin' },
})
```

### 4. Hot-update the route at runtime

```ts
server.addOrUpdate({
  id: 'basic-proxy',
  matcher: { rule: "PathPrefix('/api')", priority: 50 },
  middlewares: [{ type: 'respond', config: { status: 418, body: 'teapot' } }],
  upstreams: [
    { kind: 'tcp', address: '127.0.0.1:9000' },
  ],
})
```

## Documentation

- Docs index and LonesomeServer control API: [docs/readme.md](./docs/readme.md)
- Route lifecycle and hot updates: [docs/route.md](./docs/route.md)
- CEL expressions: [docs/cel.md](./docs/cel.md)
- `virtual_js` upstreams: [docs/virtual_js.md](./docs/virtual_js.md)
- Middlewares: *TODO*
