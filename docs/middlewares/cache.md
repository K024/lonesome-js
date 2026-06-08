# `cache`

Enables Pingora response caching for a route.

## Config

```ts
{
  type: 'cache',
  config: {
    max_ttl_secs?: number,
    max_file_size_bytes?: number,
    inject_cache_headers?: boolean,
    rule?: string,
  },
}
```

Fields:
- `max_ttl_secs`: caps freshness lifetime. Defaults to `3600`.
- `max_file_size_bytes`: optional maximum cached object size.
- `inject_cache_headers`: whether to add `Cdn-Cache-Status`. Defaults to `true`.
- `rule`: optional CEL condition.

## Example

```ts
{
  type: 'cache',
  config: {
    max_ttl_secs: 60,
    max_file_size_bytes: 1024 * 1024,
    inject_cache_headers: true,
  },
}
```

## Behavior

- Cache namespace is the route id.
- Primary cache key is `Host` plus path/query.
- `Vary` headers are honored; `Vary: *` makes the response uncacheable.
- `Cdn-Cache-Control` is preferred over regular `Cache-Control` when present.
- Requests with `Authorization` follow Pingora's HTTP cacheability rules.
- Only one `cache` middleware may be active for a route request.

## Purging

Use the exported JavaScript API to purge a route cache namespace:

```ts
import { purgeRouteCache } from 'lonesome-js'

await purgeRouteCache('route-id')
```

A purge marks existing objects in that route namespace stale for future lookups.
