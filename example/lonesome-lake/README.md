# lonesome-lake

Simple self-hosted FaaS for homelab, built on [lonesome-js](https://github.com/K024/lonesome-js) (Pingora-based proxy) and Deno workers. One process, no external DB, no complex components.

- Functions are directories under `functions/` — drop in code, the runtime hot-reloads.
- Each function runs in an isolated Deno worker with its own permissions.
- Functions can import jsr/npm dependencies (auto-fetched + locked).
- Functions are managed by **git**: edit files, commit, `git pull` on the host,
  hit **Reload**. The panel and admin API are read-only + diagnostics.

> Trust model: functions are semi-trusted (your own code). Isolation is Deno
> worker permissions only — no hard sandbox/escape hardening.

## Quick start

Requirements: Deno 2.x, Node.js (for the panel build).

```sh
cd ui && npm install             # install the panel deps (ui/node_modules)
cd .. && deno task start         # start the runtime (cwd = deployment root)
```

> The UI is self-contained in `ui/` (own package.json + node_modules). The root
> keeps no package.json and no node_modules: Deno resolves its npm deps
> (lonesome-js, yaml) from the global cache, and the panel build output lands in
> `static/` (resolved relative to the server code via `import.meta.url`).

- Functions proxy: `http://127.0.0.1:18080` (function routes only)
- Management port: `http://127.0.0.1:19090` — web panel + `http://127.0.0.1:19090/admin/api/*` on one port

The two ports are intentionally separate: the proxy only serves functions,
the management port serves the panel and admin API. Functions are never
exposed on the management port, and the panel/admin are never exposed on the
proxy port.

Smoke test:

```sh
cd ui && npm run build           # builds ui/ -> ../static
cd .. && bash scripts/smoke.sh
```

## Structure

```
config.yml                     # global config (resolved relative to cwd; generated if absent)
functions/<name>/
  handler.ts                    # default export (req: Request) => Response
  config.yml                   # matcher / permissions / env / replicas / lazy / timeoutMs
server/                         # Deno runtime (runtime + worker + admin API)
ui/                             # Preact + Tailwind + daisyUI panel (own package.json)
static/                         # ui build output (served on the management port)
data/sockets/                   # unix sockets (runtime, auto-created)
```

## Function authoring

```ts
// functions/hello/handler.ts
export default (req: Request): Response =>
  new Response(JSON.stringify({ path: new URL(req.url).pathname }), {
    headers: { 'content-type': 'application/json' },
  })
```

```yaml
# functions/hello/config.yml (optional)
matcher:
  rule: "PathPrefix('/hello')"
  priority: 50
permissions:
  net: true
env:
  GREETING: hi
replicas: 1
lazy: false
timeoutMs: 10000
```

Without `config.yml` the default matcher is `PathPrefix('/<name>')`. TS is
type-stripped at runtime; `jsr:`/`npm:` imports are allowed. Default worker
permissions: read on the functions dir, `import`, and the serving socket; add
`net`/`env`/`read` per function; `run`/`ffi`/`sys` stay denied.

## config.yml

```yaml
listen: "127.0.0.1:18080"        # functions proxy (function routes only)
threads: 1
workStealing: false
workerTransport: { kind: unix, dir: "./data/sockets", prefix: "fn-" }
loadBalancer: { algorithm: round_robin }
functionsDir: "./functions"
admin:                           # management port: panel + admin API
  listen: "127.0.0.1:19090"      # blank disables it
  staticDir: "./static"          # web panel built here (same port)
  token: ""                      # set to require x-admin-token
```

Everything resolves relative to the launch directory (`cwd`), so the binary/process
is location-independent. Functions proxy and management port are separate by design.
If no `config.yml`/`config.yaml` exists in `cwd`, the runtime generates a default
one (plus an empty `functions/`) on first boot.

## Admin API

Read-only + diagnostics. Functions are written only via git (see [docs](./docs)).
See the **Docs** tab in the panel for the full reference. Highlights:

| method | path | notes |
|---|---|---|
| GET | `/admin/api/status` | runtime + function snapshot |
| GET | `/admin/api/functions[/:name]` | list / detail (config + handler source) |
| GET | `/admin/api/logs` | ring buffer (`?source=`, `?since=`) |
| POST | `/admin/api/invoke` | test a request through the proxy |
| POST | `/admin/api/diagnostics/cel` | CEL rule/expression/analyze sandbox |
| POST | `/admin/api/reload` | re-scan files after `git pull` |

## Deployment

### Source

```sh
cd ui && npm ci && npm run build  # install panel deps + build to ../static
cd .. && deno task start          # from the deployment directory (cwd)
```

### Docker

```sh
docker build -t lonesome-lake .
# /srv/lonesome-lake is a host git repo: functions/ + optional config.yml
docker run -d -p 18080:18080 -p 19090:19090 \
  -v /srv/lonesome-lake:/workspace \
  lonesome-lake
```

The image is source-only (server + baked panel under `/app`); the deployment
root is `/workspace` (the container's cwd). Mount your git repo there — functions
and config live on the host, the runtime hot-reloads on `git pull` + **Reload**.
If the repo has no `config.yml`, the runtime generates a default one into
`/workspace` on first boot (plus an empty `functions/`). The baked panel is served
from the image, independent of `cwd`. Native binding is installed for the build
platform's architecture.

## Security notes

- Per-function Deno worker permissions are the isolation boundary. Worker
  permissions can never exceed the parent process, so the runtime runs with a
  narrowed set: `read` (deployment root; `/app,/workspace` in Docker),
  `write` on the deployment root, `net env import ffi`, and
  **denies `run` and `sys`** — a function can therefore never be configured
  with process spawn or system calls.
- `net`/`env`/`import`/`ffi` stay broad because the native binding load and
  worker capabilities (jsr/npm deps, outbound `net`, unix sockets) must not
  exceed the parent; `run`/`sys` are the denied boundary.
- `read` is limited to the deployment root (plus `/app` for the worker template
  in Docker); `write` covers the deployment root so the runtime can generate a
  default `config.yml` and socket dir — functions are git-managed, so the
  runtime never edits `functions/`. Broader paths in
  `config.yml` (e.g. a unix socket dir outside cwd) require widening these flags.
- Admin listener defaults to `127.0.0.1`; set `admin.token` before exposing it.
- A function with `net` can reach other services on the host. Grant narrowly.
- No quotas, no durable logs, no multi-tenancy hardening — by design (homelab scope).

## Development

```sh
deno task check            # type-check the server
cd ui && npm run dev       # deno runtime + panel dev server (proxies /admin to 127.0.0.1:19090)
deno task fmt
```
