# `compression`

Configures downstream response compression and optional upstream response decompression.

## Config

```ts
{
  type: 'compression',
  config: {
    gzip?: number,
    br?: number,
    zstd?: number,
    decompress_upstream?: boolean,
    preserve_etag?: boolean,
    rule?: string,
  },
}
```

Fields:
- `gzip`, `br`, `zstd`: compression level for each algorithm. Each level must be in `[0, 11]`.
- `decompress_upstream`: controls upstream response decompression.
- `preserve_etag`: controls whether ETag is preserved through compression/decompression.
- `rule`: optional CEL condition.

## Example

```ts
{
  type: 'compression',
  config: {
    gzip: 6,
    br: 4,
    zstd: 3,
    decompress_upstream: true,
    preserve_etag: false,
  },
}
```

## Notes

- The middleware adjusts Pingora's compression modules; actual encoding still depends on client `Accept-Encoding` and Pingora behavior.
- Set a level only for algorithms you want to tune.
