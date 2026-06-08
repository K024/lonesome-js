# `redirect_https`

Redirects requests between HTTP and HTTPS schemes based on the downstream request scheme.

## Config

```ts
{
  type: 'redirect_https',
  config: {
    code?: 301 | 302 | 303 | 307 | 308,
    port?: number,
    to_http?: boolean,
    rule?: string,
  },
}
```

Defaults:
- `code`: `301`
- `to_http`: `false`

Fields:
- `port`: optional target port. Default ports (`443` for HTTPS, `80` for HTTP) are omitted from the generated URL.
- `to_http`: when true, redirects HTTPS to HTTP; otherwise redirects HTTP to HTTPS.
- `rule`: optional CEL condition.

## Example

```ts
{
  type: 'redirect_https',
  config: { code: 301, port: 443 },
}
```

## Behavior

- The target host is taken from the `Host` header or request URI authority.
- Path and query are preserved.
- If the request is already on the target scheme, the middleware continues.
- Redirect responses have an empty body.
