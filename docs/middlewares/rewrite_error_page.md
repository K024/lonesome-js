# rewrite_error_page

Replaces an **upstream** error status response (`>= 400`) with a page rendered
from the [error page store](../readme.md#error-pages), instead of forwarding
the upstream error body. This is the opt-in way to apply error pages to
upstream 5xx responses — without this middleware, upstream error responses are
always forwarded verbatim.

```ts
middlewares: [
  { type: 'rewrite_error_page', config: {} },
],
```

## Config

| field | type | default | meaning |
|---|---|---|---|
| `status` | `number \| string` | any | which upstream error statuses to intercept. A single code or a spec like `'500-503,504'`. |
| `rule` | `string` (CEL) | always | applies only when the CEL rule evaluates to true. |

## Behavior

- Only **upstream** responses are considered (the proxy's own generated errors —
  gate 400/421, connect failures 502, middleware errors — already consult the
  store directly).
- Interception requires a matching page in the error page store; when none
  matches, the upstream response is forwarded unchanged.
- The rendered page wins: `statusOverride`, `headers`, `contentType`, static
  `body` or `bodyExpression` all apply. `ErrorStatusValue()` reports the
  upstream status.
- The page matcher (CEL) and status spec of the store entry still gate
  rendering, exactly as for generated errors.

```ts
// intercept upstream 502/503/504, serve the store page for those statuses
server.updateErrorPage({
  id: 'gw',
  status: '502-504',
  matcher: "PathPrefix('/api')",
  body: 'API gateway unavailable',
})

server.addOrUpdate({
  id: 'api',
  matcher: { rule: "PathPrefix('/api')", priority: 50 },
  middlewares: [{ type: 'rewrite_error_page', config: { status: '502-504' } }],
  upstreams: [{ kind: 'tcp', address: '127.0.0.1:9000' }],
})
```

## Known limitation: body-less upstream errors

A body-less upstream error (`Content-Length: 0`) is **not** replaced. Pingora
never invokes the upstream response body filter when the response has no body
(it signals end-of-stream directly), so the replacement page body could never be
written. To avoid advertising the page's `Content-Length` while sending zero
bytes (which would corrupt the response), the middleware passes body-less
upstream errors through unchanged.

The same gap exists in pingap: its response-phase `FullyReplaced(HttpResponse)`
plugin result is a `TODO`. If your upstream emits error responses without a
body and you need them replaced, make the upstream return a body (any content),
or handle the replacement at the request phase (before proxying) instead.
