# Deno App Example

This example shows how to run `lonesome-js` from Deno via the npm package and use Deno workers as local HTTP upstreams.

> This is a demo of a serverless-style hosting environment, not a production-ready serverless platform. It intentionally omits hard multi-tenant isolation, sandbox escape hardening, quota enforcement, durable scheduling, observability, billing, and other controls required for real production hosting.

It is intentionally small, but includes a few useful patterns:

- serverless-style routing from one proxy listener to multiple worker handlers
- runtime route registration with `LonesomeServer.addOrUpdate()`
- hot-reloading `config.json`
- lazy worker activation through an interceptor
- runtime-assigned worker listen addresses
- loopback or Unix socket worker transport
- multiple worker replicas with round-robin load balancing
- per-worker Deno permissions

## Scope

Use this app as a reference for local experiments, API shape exploration, and lifecycle orchestration ideas. Do not treat it as a secure serverless runtime for untrusted user code.

## Requirements

- Deno with npm package support and worker options enabled.
- A local/server environment where Deno may load the native binding from `npm:lonesome-js`.

## Run

From this directory:

```sh
deno task start
```

The proxy listens on `127.0.0.1:18080` by default.

Try:

```sh
curl 'http://127.0.0.1:18080/api?hello=deno'
curl 'http://127.0.0.1:18080/static/data.json'
```

Type-check:

```sh
deno task check
```

## How it is structured

- `main.ts` owns app state, dispatches reducer events, and runs effects.
- `lib/reducer.ts` is the state machine for config load, hot reload, worker lifecycle, lazy activation, and route updates.
- `lib/effects.ts` performs side effects: starting `LonesomeServer`, spawning workers, registering interceptors, and applying routes.
- `lib/runtime-config.ts` materializes config by assigning worker addresses and appending required Deno permissions.
- `lib/worker-route.ts` converts worker addresses into Lonesome upstream config.
- `worker.ts` runs inside each Deno worker and starts a small `Deno.serve()` upstream.
- `handlers/*.ts` are example request handlers.

## Config notes

`config.json` contains proxy listeners and logical workers. Each worker becomes one route and one or more Deno worker instances.

### Worker transport

`workerTransport` controls how the parent proxy reaches worker HTTP servers:

```json
{ "workerTransport": { "kind": "unix" } }
```

Unix socket transport is useful for local-only worker traffic and avoids port collisions. The app assigns socket paths at runtime using the configured `dir` and `prefix`.

```json
{ "workerTransport": { "kind": "unix", "dir": "/tmp", "prefix": "ls-" } }
```

Loopback TCP is also supported:

```json
{
  "workerTransport": {
    "kind": "loopback",
    "hostname": "127.0.0.1",
    "startPort": 19000,
    "maxPortAttempts": 1000
  }
}
```

The assigned socket paths or ports are automatically appended to each worker permission config unless that permission is `true` or `inherit`.

### Lazy workers

A worker with `lazy: true` is not spawned at startup. Instead, the initial route includes an interceptor; the first matching request triggers worker startup, waits for readiness, then continues.

For loopback transport, lazy workers may still race with another process taking the pre-assigned port between config load and activation. The example logs a warning for that case. Unix transport is the simpler choice for lazy local workers.

### Replicas

A worker can declare replicas:

```json
{ "name": "api-worker", "replicas": 2 }
```

Replicas create multiple identical Deno worker instances and multiple upstreams for the generated route. `replicas > 1` is forced to eager mode (`lazy: false`) with a warning, because a lazy route should activate one logical worker at a time.

When using multiple Unix upstreams, configure round-robin load balancing:

```json
{ "loadBalancer": { "algorithm": "round_robin" } }
```

The example config does this by default.

### Hot reload

`main.ts` watches `config.json`. On change, the reducer queues reconciliation and changes one logical worker at a time so only one worker is in an intermediate state.

Some listener-level changes still require stopping and starting the proxy listener; worker-level changes are handled by replacing or adding the affected worker route.

## Permissions

Workers use Deno's worker permissions. You can grant broad permissions for quick experiments:

```json
{ "permissions": { "read": true, "env": true } }
```

Or grant narrow permissions. Runtime transport permissions are added automatically:

- loopback: `net` gets `host:port`
- Unix socket: `read` and `write` get the socket path

## Formatting

This example uses Deno formatting with semicolons disabled and single quotes:

```sh
deno fmt
```
