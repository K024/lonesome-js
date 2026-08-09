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

## Static Rule Analysis

`analyzeRule(rule)` statically inspects a matcher CEL rule and returns:

```ts
interface RuleConstraints {
  hosts: string[]        // Host("...") literals, `*.example.com` wildcard included
  paths: string[]        // Path("...") literals
  pathPrefixes: string[] // PathPrefix("...") literals
  fullyPrecheckable: boolean
}
```

This is useful for certificate automation: `hosts` are the exact hostnames the
rule can match, and a `Host("*.example.com")` pattern lines up with a
`*.example.com` wildcard certificate.

Only simple boolean rules are analyzed: `Host`/`Path`/`PathPrefix` literals
combined with `&&`, `||`, `!`, and the ternary. Complex CEL such as
`HostRegexp`, comparisons, or member calls (`PathValue().startsWith(...)`) is
not analyzed — for such rules the caller must handle the semantics itself.

### Soundness (certificate automation)

The extraction is deliberately conservative and must be read as a **lower
bound**, not the exact host set of the rule. Every `Host` literal is included
regardless of context — under `!`, inside a ternary branch, or on one side of
`||` — while negations, conditional structure, and unanalyzable sub-expressions
(`Header`, comparisons, `HostRegexp`, ...) are ignored. Both directions are
harmless for provisioning:

- **Over-provisioning is fine**: listing a host that never actually matches
  (e.g. `!Host("a")` still reports `a`) only wastes a certificate.
- **Under-provisioning is not allowed**: any host a rule can match is either
  enumerated (it appears as a `Host` literal) or covered by the caller's
  wildcard fallback, which must be provisioned whenever the rule contains
  unanalyzable parts.

So provisioning `hosts` together with a wildcard fallback can never miss a
certificate the rule actually needs. The cost is that `hosts` is a minimum.

### `fullyPrecheckable`

`fullyPrecheckable` reports whether the internal request fast path (the cheap
pre-check) can decide the whole expression by itself — i.e. the built pre-check
tree contains no unknown leaf, so the full CEL program is never consulted.

It is **not** a claim that `hosts` is exact. For example
`Host("a") ? Path("/x") : PathPrefix("/y")` is fully pre-checkable, yet its
else branch can match any host, so provisioning only `a` is not sufficient.

## Rule Evaluation (Offline Testing)

`evaluateRule(rule, request)` and `evaluateExpression(expression, request?)`
run CEL against a synthetic request built from minimal inputs — no proxy and no
real traffic needed. Both share the same request shape:

```ts
interface RequestOptions {
  method: string // e.g. 'GET'
  path: string   // origin-form, query included: '/api?debug=1'
  headers?: Array<{ name: string, value: string }>
}
```

### `evaluateRule(rule, request)`

Evaluates a matcher rule and returns what the internal fast path would have
decided plus the real result:

```ts
{
  precheck: 'true' | 'false' | 'unknown' // what the route fast path decides
  matches: boolean                        // actual CEL result
}
```

`precheck` is `'true'`/`'false'` when the cheap pre-check decides the rule by
itself (it then always agrees with `matches`); `'unknown'` means the fast path
could not handle or fully decide it, so the full CEL program was consulted.
Compile failures, unknown functions at runtime, and non-boolean results are
thrown as errors rather than silently treated as no-match.

### `evaluateExpression(expression, request?)`

The general-purpose entry for every non-matcher CEL usage — `body_expression`,
`set_variable.expression`, `request_headers`/`response_headers.expression`,
`rewrite`/`redirect` cel modes, `rate_limit` keys, `loadBalancer.hashKeyRule` —
and a request-context inspector (`HostValue()`, `PathValue()`, `ClientIPValue()`,
`RequestTime()`, ...). It returns the resulting value as JSON
(string/number/boolean/list/object/null). `request` is optional: when omitted a
default session is used (GET `/`, no headers), so session functions see their
empty defaults. Results with no JSON equivalent (durations, opaque objects) are
thrown as errors.

### Synthetic request semantics

- `host` comes from a `host` header when provided. Synthetic requests have no
  TLS, so no SNI; on real TLS traffic the session resolves SNI first, then the
  `host` header (see [Session Data Semantics](#session-data-semantics)).
- `path` is percent-decoded and its query is parsed into `Query(...)`/`QueryValue`.
- Everything else takes its default: empty `ClientIP`, no JWT payload, no
  upstream response header, `RequestTime` = now.

## Performance

Route matcher rules that are pure boolean combinations of `Host`, `Path`, and
`PathPrefix` (for example `Host("example.com") && PathPrefix("/api")`) take a
semantics-preserving fast path: the cheap checks are evaluated first, and the
full CEL program only runs when the cheap part cannot decide. This is purely
internal — it does not change matching semantics or priority ordering. All
other rules execute the full CEL program as usual.

## Built-in CEL Functions

### Standard utility functions

- `now()` returns the current UTC timestamp.
- `random()` returns a random `double` in the range `[0.0, 1.0)`.

These functions use the standard CEL camelCase/lowercase naming style. PascalCase
functions in this project are reserved for helpers that read request/session data.

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

`Host` supports `*.` wildcard subdomain matching with DNS/TLS semantics:
`Host("*.example.com")` matches exactly one subdomain label, so `api.example.com`
matches but `example.com` (the apex) and `a.b.example.com` (multiple labels) do
not. Use `HostRegexp` for more complex host matching.

### Value functions

- `HostValue()`
- `MethodValue()`
- `PathValue()`
- `HeaderValue(name)`
- `QueryValue(name)`
- `ClientIPValue()`
- `RequestTime()`
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
