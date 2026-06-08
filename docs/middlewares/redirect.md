# `redirect`

Short-circuits requests with an HTTP redirect.

## Config

```ts
{
  type: 'redirect',
  config: {
    code: 301 | 302 | 303 | 307 | 308,
    target_mode: 'static' | 'cel' | 'regex_replace',
    target?: string,
    expression?: string,
    find?: string,
    replace?: string,
    rule?: string,
  },
}
```

Target modes:
- `static`: uses `target` as the `Location` header.
- `cel`: evaluates `expression`; it must return a string.
- `regex_replace`: applies `find`/`replace` to the current path and query.

## Examples

```ts
{
  type: 'redirect',
  config: { code: 302, target_mode: 'static', target: 'https://example.com/new' },
}
```

```ts
{
  type: 'redirect',
  config: {
    code: 301,
    target_mode: 'regex_replace',
    find: '^/old/(.*)$',
    replace: '/new/$1',
  },
}
```

## Notes

- Only `301`, `302`, `303`, `307`, and `308` are accepted.
- If a dynamic target cannot be produced, the request continues to the next middleware/upstream.
- Redirect responses have an empty body.
