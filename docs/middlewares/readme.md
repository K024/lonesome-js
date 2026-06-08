# Middleware Reference

Middlewares are attached to routes and run in the order they are listed in `route.middlewares`.

```ts
server.addOrUpdate({
  id: 'example',
  matcher: { rule: "PathPrefix('/api')", priority: 50 },
  middlewares: [
    { type: 'request_headers', config: { name: 'x-route', action: 'set', value: 'example' } },
    { type: 'cache', config: { max_ttl_secs: 60 } },
  ],
  upstreams: [{ kind: 'tcp', address: '127.0.0.1:9000' }],
})
```

## Common fields

Most middlewares accept an optional `rule` field. `rule` is a CEL expression evaluated against the current request/session context. The middleware applies only when the expression returns `true`.

```ts
{ type: 'respond', config: { status: 403, rule: "PathPrefix('/admin')" } }
```

See [../cel.md](../cel.md) for available CEL functions and examples.

## Available middlewares

- [basic_auth](./basic_auth.md)
- [cache](./cache.md)
- [compression](./compression.md)
- [cors](./cors.md)
- [health_check](./health_check.md)
- [jwt](./jwt.md)
- [rate_limit](./rate_limit.md)
- [redirect](./redirect.md)
- [redirect_https](./redirect_https.md)
- [request_headers](./request_headers.md)
- [respond](./respond.md)
- [response_headers](./response_headers.md)
- [rewrite](./rewrite.md)
- [rewrite_method](./rewrite_method.md)
- [set_variable](./set_variable.md)

`interceptor` is documented separately at [../interceptor.md](../interceptor.md) because it also has a JavaScript registration API.
