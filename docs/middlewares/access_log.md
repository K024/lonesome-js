# `access_log`

Appends a line per request to a configured file. Enabled by adding the
middleware to a route; it is off by default.

Logs are **never** written to the process stdio, which is shared with the
hosting JS runtime. Each log file path has a single dedicated writer task that
runs on the same Tokio runtime, so concurrent requests (and multiple routes
logging to the same file) never interleave lines.

## Config

```ts
{
  type: 'access_log',
  config: {
    format?: 'text' | 'json',  // default: 'text'
    file: string,              // required
    ext?: string,              // optional CEL expression
  },
}
```

- `format`: output format. `'text'` is a single human-readable line; `'json'`
  is a JSON object per line.
- `file`: absolute or relative path to append to. The file is created if it
  does not exist. Required.
- `ext`: optional CEL expression evaluated per request; its scalar result is
  included in every line as the `ext` field. Empty string when absent or when
  evaluation fails. The full request context is available (`MethodValue()`,
  `PathValue()`, `HostValue()`, `HeaderValue(...)`, `TraceIdValue()`, ...).

## Example

```ts
server.addOrUpdate({
  id: 'audited',
  matcher: { rule: "PathPrefix('/api')", priority: 50 },
  middlewares: [
    {
      type: 'access_log',
      config: {
        format: 'json',
        file: '/var/log/lonesome/access.log',
        ext: "'user=' + HeaderValue('x-user') + '|trace=' + TraceIdValue()",
      },
    },
  ],
  upstreams: [{ kind: 'tcp', address: '127.0.0.1:9000' }],
})
```

## Logged fields

- timestamp (RFC 3339)
- request method and path
- response status
- latency in ms
- selected upstream address
- `ext`, when an `ext` expression is configured
- error, when the request failed

## Notes

- The file open is validated when the route is built (bad paths fail fast).
- Writing is best-effort: the request path only enqueues the line and never
  blocks on I/O. Under extreme load a bounded queue may drop lines.
