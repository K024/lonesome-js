# `rate_limit`

Limits request rate per key over a fixed observation period.

## Config

```ts
{
  type: 'rate_limit',
  config: {
    mode: 'remote_ip' | 'header' | 'expression',
    header_name?: string,
    key?: string,
    max_rps: number,
    status?: number,
    include_headers?: boolean,
    rule?: string,
  },
}
```

Modes:
- `remote_ip`: key by downstream client IP.
- `header`: key by request header value. Requires `header_name`.
- `expression`: key by CEL expression result. Requires `key`.

Fields:
- `max_rps`: allowed average requests per second per key. Must be greater than `0`.
- `status`: response status when limited. Defaults to `429`.
- `include_headers`: adds `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`. Defaults to `true`.
- `rule`: optional CEL condition.

## Examples

```ts
{ type: 'rate_limit', config: { mode: 'remote_ip', max_rps: 10 } }
```

```ts
{
  type: 'rate_limit',
  config: {
    mode: 'expression',
    key: "HeaderValue('authorization')",
    max_rps: 5,
    status: 429,
  },
}
```

## Notes

- The current observation window is 10 seconds, so `max_rps` is converted to a maximum request count per 10-second window.
- If the key cannot be derived, the middleware continues without limiting.
- Limited responses disable downstream keep-alive.
