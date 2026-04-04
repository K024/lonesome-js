# CEL Expressions

This project uses CEL (Common Expression Language) for route matching, middleware conditions, and dynamic value generation. The CEL implementation is from [cel-rust](https://github.com/cel-rust/cel-rust).

## Where CEL Is Evaluated

CEL is used in three main places:

- Route matcher: `route.matcher.rule`
- Middleware rule gates: many middlewares support `rule`
- Dynamic value fields:
  - `respond.body_expression`
  - `request_headers.expression`
  - `response_headers.expression`
  - `rewrite` in `cel_rewrite` mode
  - `redirect` in `target_mode: cel`
  - `set_variable.expression`
  - `rate_limit.mode: expression.key`
  - `loadBalancer.hashKeyRule`

## Execution Model

- Route matcher CEL is compiled when route config is added.
- Middleware CEL programs are compiled when middleware instances are built.
- Evaluation happens per request, using a request-scoped CEL context.
- If a matcher expression does not return a boolean, the route is treated as not matched.
- Middleware `rule` expressions apply only when they evaluate to `true`.

## Built-in CEL Functions

### Predicates (boolean)

- `Host(expected)`
- `HostRegexp(pattern)`
- `Method(expected)`
- `Path(expected)`
- `PathPrefix(prefix)`
- `PathRegexp(pattern)`
- `Header(name, value)`
- `HeaderRegexp(name, pattern)`
- `Query(name, value)`
- `QueryRegexp(name, pattern)`
- `ClientIP(ip_or_cidr)`
- `JwtClaim(name, expected)`

### Value functions

- `HostValue()`
- `MethodValue()`
- `PathValue()`
- `HeaderValue(name)`
- `QueryValue(name)`
- `ClientIPValue()`
- `JwtClaimValue(name)`
- `JwtPayloadValue()`

### Upstream response functions

- `ResponseStatusValue()`
- `ResponseHeaderValue(name)`

These are useful in upstream-response and response stages (for example with `set_variable` or `response_headers`).

## Session Data Semantics

### `HostValue()` priority

Host resolution is:

1. TLS SNI (if available)
2. Request `Host` header (port removed)
3. URI authority host
4. Empty string

### `PathValue()` decoding

`PathValue()` returns a percent-decoded path.

Example:
- Request path: `/cel/fn/%E4%BD%A0%E5%A5%BD`
- `PathValue()`: `/cel/fn/你好`

### Missing values

Most value helpers return an empty string when data is missing.

## Middleware-Specific CEL Notes

### `respond.body_expression`

Supported result types are scalar values:
- string
- int / uint / float
- bool

Non-scalar values produce middleware internal error.

### `set_variable.expression`

`set_variable` can run in different stages:
- `request`
- `upstream_response`
- `response`

You can use this to capture values from one stage and reuse them later.

### `loadBalancer.hashKeyRule`

`hashKeyRule` is used as the selection key for multi-upstream balancing.

- Scalar CEL results are converted to bytes.
- Non-scalar results cause upstream selection error.
- CEL context must already exist when the key is evaluated.

## Practical Examples

### Route matcher

```ts
matcher: {
  rule: "Method('POST') && PathPrefix('/api') && Query('debug', '1')",
  priority: 80,
}
```

### Conditional middleware

```ts
{
  type: 'request_headers',
  config: {
    name: 'x-rule-hit',
    action: 'set',
    value: '1',
    rule: "HeaderRegexp('x-user', '^u[0-9]+$') && QueryRegexp('id', '^[0-9]{2}$')",
  },
}
```

### Dynamic body

```ts
{
  type: 'respond',
  config: {
    status: 200,
    body_expression: "MethodValue() + ' ' + PathValue() + '?' + QueryValue('q')",
    content_type: 'text/plain; charset=utf-8',
  },
}
```

### Upstream response metadata propagation

```ts
middlewares: [
  {
    type: 'set_variable',
    config: {
      name: 'up_meta',
      stage: 'upstream_response',
      expression: "string(ResponseStatusValue()) + '|' + ResponseHeaderValue('x-from-upstream')",
    },
  },
  {
    type: 'response_headers',
    config: {
      name: 'x-up-meta',
      action: 'set',
      expression: 'up_meta',
    },
  },
]
```

## Error Handling

- CEL compile failures reject route/middleware creation.
- Matcher execution failures are treated as no match.
- Middleware expression failures return internal middleware errors for that request.
