# Denali.js Implementation Plan

## Project Overview

**Denali.js** is a custom Deno worker runtime built with [Pingora](https://github.com/cloudflare/pingora) (Cloudflare's proxy framework). It provides a TypeScript API to configure a high-performance proxy server.

### Current State

- Cargo workspace with `cli` and `core` crates (stub implementations)
- Pingora dependency already added to `core`
- TypeScript type definitions ready (`denali.d.ts`)
- Demo showing expected API usage (`demo.ts`)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     denali-cli                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Embedded Deno Runtime                               │    │
│  │  - Parses config.ts                                  │    │
│  │  - Exposes "denali" module to JS                     │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     denali-core                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ Pingora      │  │   Router     │  │ Application  │       │
│  │ Server       │◄─┤  (4 types)   │◄─┤   Registry   │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                Application Types                     │    │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐       │    │
│  │  │ Reverse    │ │ Static     │ │ Worker     │       │    │
│  │  │ Proxy      │ │ Files      │ │ (Deno)     │       │    │
│  │  └────────────┘ └────────────┘ └────────────┘       │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Core Server Infrastructure

### 1.1 Pingora Server Base

**File:** `core/src/server.rs`

```rust
use pingora::prelude::*;
use pingora::proxy::HttpProxy;

pub struct DenaliServer {
    router: Arc<dyn Router>,
    registry: Arc<RwLock<ApplicationRegistry>>,
}

impl DenaliServer {
    pub fn new(router: Arc<dyn Router>) -> Self { ... }
    pub fn listen(&self, addresses: Vec<String>) -> StopHandle { ... }
}
```

### 1.2 Router Types

**File:** `core/src/router/mod.rs`

| Router Type  | Description                   | Route Example        |
| ------------ | ----------------------------- | -------------------- |
| `domain`     | Match by domain/host header   | `"api.example.com"`  |
| `path`       | Match by URL path prefix      | `"/api/*"`, `"/static/*"` |
| `expression` | CEL expression matching       | `"request.path.startsWith('/api/')"` |
| `script`     | Custom JS routing function    | `"./router.ts"`      |

```rust
pub enum RouterType {
    Domain,
    Path,
    Expression,
    Script,
}

pub trait Router: Send + Sync {
    fn match_request(&self, req: &RequestHeader) -> Option<String>;
}
```

**Implementation files:**
- `core/src/router/domain.rs` - Domain-based routing
- `core/src/router/path.rs` - Path prefix matching with glob support
- `core/src/router/expression.rs` - CEL expression matching
- `core/src/router/script.rs` - JavaScript routing function

### 1.3 Application Registry

**File:** `core/src/registry.rs`

```rust
pub struct ApplicationRegistry {
    apps: HashMap<String, Arc<dyn Application>>,
}

impl ApplicationRegistry {
    pub fn add(&mut self, name: String, app: Arc<dyn Application>);
    pub fn remove(&mut self, name: &str) -> Option<Arc<dyn Application>>;
    pub fn get(&self, name: &str) -> Option<Arc<dyn Application>>;
}
```

### 1.4 Application Trait

**File:** `core/src/application/mod.rs`

```rust
#[async_trait]
pub trait Application: Send + Sync {
    fn name(&self) -> &str;
    fn route(&self) -> &str;
    async fn handle_request(&self, session: &mut Session, ctx: &mut Context) -> Result<()>;
}
```

---

## Phase 2: Application Types

### 2.1 ReverseProxyApplication

**File:** `core/src/application/reverse_proxy.rs`

Features:
- Load balancing across `upstreams`
- Connection pooling via Pingora
- Health checking

```rust
pub struct ReverseProxyApplication {
    name: String,
    route: String,
    upstreams: LoadBalancer<RoundRobin>,
}
```

### 2.2 StaticFilesApplication

**File:** `core/src/application/static_files.rs`

Features:
- Serve files from `root` directory
- MIME type detection
- Caching headers
- Range requests support

```rust
pub struct StaticFilesApplication {
    name: String,
    route: String,
    root: PathBuf,
}
```

### 2.3 WorkerApplication

**File:** `core/src/application/worker.rs`

*defer implementation*

Features:
- Embed `deno_runtime` to execute TypeScript workers
- `assetsRoot` for serving static assets alongside worker
- `notFoundHandler` options:
  - `"script"` → let the worker handle 404s
  - `"single-page-application"` → serve index.html for all routes
  - `"404-page"` → serve a 404.html page

```rust
pub struct WorkerApplication {
    name: String,
    route: String,
    script_url: PathBuf,
    assets_root: Option<PathBuf>,
    not_found_handler: NotFoundHandler,
    runtime: DenoRuntime,
}
```

---

## Phase 3: CLI & JavaScript Bridge

### 3.1 Dependencies

**File:** `cli/Cargo.toml`

```toml
[dependencies]
denali-core = { path = "../core" }
deno_core = "0.x"
deno_runtime = "0.x"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

### 3.2 JavaScript Module

The CLI exposes a `Server` class to JavaScript that maps to the Rust implementation:

```javascript
// What JS sees (matches denali.d.ts)
import { Server } from "denali"

const server = new Server({ routerType: "path" })
  .addStaticFiles({ name: "static", route: "/static/*", root: "./public" })
  .addWorker({ name: "worker", route: "/", scriptUrl: "./worker.ts" })

const stop = server.listen(["localhost:3000"])
```

### 3.3 Deno Extension (Core)

**File:** `core/src/ext/mod.rs`

The bridge is implemented in `/core` as a Deno extension, exposing ops and the `denali` JS module:

```rust
#[op2]
fn op_server_new(#[serde] options: ServerOptions) -> u32 { ... }

#[op2]
fn op_server_add_reverse_proxy(server_id: u32, #[serde] options: ReverseProxyOptions) { ... }

#[op2]
fn op_server_add_static_files(server_id: u32, #[serde] options: StaticFilesOptions) { ... }

#[op2]
fn op_server_add_worker(server_id: u32, #[serde] options: WorkerOptions) { ... }

#[op2]
fn op_server_remove_application(server_id: u32, name: String) { ... }

#[op2(async)]
async fn op_server_listen(server_id: u32, #[serde] addresses: Vec<String>) -> u32 { ... }

#[op2]
fn op_server_stop(handle_id: u32) { ... }

pub fn denali_ext() -> Extension { ... }
```

**File:** `core/src/ext/denali.js` — JavaScript glue code for the `denali` module

### 3.4 CLI Bootstrap

**File:** `cli/src/main.rs`

The CLI is a thin wrapper that:
- Initializes `deno_runtime`
- Loads the `denali_ext()` extension from core
- Executes the user's config file
- Keeps the event loop running while the server is active

---

## Phase 4: Middleware (Future)

### 4.1 Middleware Interface

**File:** `core/src/middleware/mod.rs`

```rust
#[async_trait]
pub trait Middleware: Send + Sync {
    async fn process_request(&self, req: &mut RequestHeader) -> Result<()>;
    async fn process_response(&self, resp: &mut ResponseHeader) -> Result<()>;
}
```

### 4.2 Available Middleware

| Middleware  | Purpose                              |
| ----------- | ------------------------------------ |
| `encode`    | Response compression (gzip, br, zstd)|
| `basicAuth` | HTTP Basic Authentication            |

**Implementation files:**
- `core/src/middleware/encode.rs`
- `core/src/middleware/basic_auth.rs`

---

## Target File Structure

```
denali-js/
├── Cargo.toml
├── cli/
│   ├── Cargo.toml
│   └── src/
│       └── main.rs          # Bootstrap deno_runtime, load core ext
├── core/
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs           # Library exports
│       ├── server.rs        # DenaliServer implementation
│       ├── router/
│       │   ├── mod.rs
│       │   ├── domain.rs
│       │   ├── path.rs
│       │   ├── expression.rs
│       │   └── script.rs
│       ├── application/
│       │   ├── mod.rs
│       │   ├── reverse_proxy.rs
│       │   ├── static_files.rs
│       │   └── worker.rs
│       ├── registry.rs
│       ├── ext/
│       │   ├── mod.rs       # Deno ops & extension export
│       │   └── denali.js    # JS glue for "denali" module
│       └── middleware/
│           ├── mod.rs
│           ├── encode.rs
│           └── basic_auth.rs
├── denali.d.ts              # TypeScript definitions ✓
├── demo.ts                  # Example usage ✓
├── IMPLEMENTATION_PLAN.md   # This file
└── README.md
```

---

## Implementation Order

### Recommended Sequence

1. **Phase 1.4** - Application trait → defines the interface
2. **Phase 1.3** - Registry → stores applications
3. **Phase 1.2** - Router → matches requests to apps
4. **Phase 1.1** - Server → ties everything together
5. **Phase 2.2** - StaticFiles → simplest app type to test
6. **Phase 2.1** - ReverseProxy → leverages Pingora's strength
7. **Phase 3** - CLI → enables running `demo.ts`
8. **Phase 2.3** - Worker → most complex, requires Deno embedding
9. **Phase 4** - Middleware → can be added incrementally

### Rationale

- Start from the innermost abstractions (traits) and work outward
- StaticFiles is simpler than ReverseProxy for initial testing
- CLI bridge is needed before Worker can be fully tested
- Middleware is optional and can be added after core functionality works

---

## Key Dependencies

*will be decided later*

Do NOT modify Cargo.toml directly. Use `cargo` command to install latest versions instead. 

### Core Crate

```toml
[dependencies]
async-trait = "0.1"
pingora = { version = "0.6.0", features = ["openssl", "proxy", "lb", "cache", "time"] }
pingora-limits = "0.6.0"
pingora-runtime = "0.6.0"
tokio = { version = "1", features = ["full"] }
cel = "0.12"
mime_guess = "2"
deno_core = "0.330"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

### CLI Crate

```toml
[dependencies]
denali-core = { path = "../core" }
deno_runtime = "0.195"
tokio = { version = "1", features = ["full"] }
clap = { version = "4", features = ["derive"] }
```

---

## API Reference (from denali.d.ts)

*will be more detailed later*

### ServerOptions

```typescript
type ServerRouterType = "domain" | "path" | "expression" | "script"

interface ServerOptions {
  routerType: ServerRouterType
}
```

### ApplicationOptions

```typescript
interface ApplicationOptions {
  name: string    // Unique name for the application
  route: string   // Route data used to match the application
}
```

### ReverseProxyApplicationOptions

```typescript
interface ReverseProxyApplicationOptions extends ApplicationOptions {
  upstreams: string[]  // List of upstream server URLs
}
```

### StaticFilesApplicationOptions

```typescript
interface StaticFilesApplicationOptions extends ApplicationOptions {
  root: string  // Root directory for static files
}
```

### WorkerApplicationOptions

```typescript
interface WorkerApplicationOptions extends ApplicationOptions {
  scriptUrl: string                                          // Path to worker script
  assetsRoot?: string                                        // Optional static assets directory
  notFoundHandler?: "script" | "single-page-application" | "404-page"
}
```

### Server Class

```typescript
class Server {
  constructor(options: ServerOptions)
  addReverseProxy(options: ReverseProxyApplicationOptions): this
  addStaticFiles(options: StaticFilesApplicationOptions): this
  addWorker(options: WorkerApplicationOptions): this
  removeApplication(name: string): this
  listen(addresses: string[]): () => void  // Returns stop function
}
```
