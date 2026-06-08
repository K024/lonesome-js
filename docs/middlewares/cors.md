# `cors`

Adds CORS headers to responses and handles CORS preflight requests.

## Config

```ts
{
  type: 'cors',
  config: {
    allow_origin?: string,
    allow_methods?: string,
    allow_headers?: string,
    expose_headers?: string,
    allow_credentials?: boolean,
    max_age_secs?: number,
    reflect_host?: boolean,
    rule?: string,
  },
}
```

Defaults:
- `allow_origin`: `*`
- `allow_methods`: `GET,POST,PUT,PATCH,DELETE,OPTIONS`
- `allow_headers`: `*`
- `allow_credentials`: `false`
- `reflect_host`: `false`

## Example

```ts
{
  type: 'cors',
  config: {
    allow_origin: 'https://app.example.com',
    allow_methods: 'GET,POST,OPTIONS',
    allow_headers: 'authorization,content-type',
    allow_credentials: true,
    max_age_secs: 600,
  },
}
```

## Behavior

- `OPTIONS` requests are short-circuited with `204` and CORS headers.
- Non-`OPTIONS` responses receive the configured CORS headers.
- When `reflect_host` is true and `allow_origin` is `*`, the middleware uses `https://<host>` as `Access-Control-Allow-Origin` and appends `Vary: host`.
