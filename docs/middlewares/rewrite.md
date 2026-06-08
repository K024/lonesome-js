# `rewrite`

Rewrites the request path and query before upstream proxying.

## Config

```ts
{
  type: 'rewrite',
  config: {
    mode: 'regex_rewrite' | 'cel_rewrite',
    find?: string,
    replace?: string,
    expression?: string,
    rule?: string,
  },
}
```

Modes:
- `regex_rewrite`: applies regex `find` and replacement `replace` to the current path and query.
- `cel_rewrite`: evaluates `expression`; it must return the new path/query string.

## Examples

```ts
{
  type: 'rewrite',
  config: { mode: 'regex_rewrite', find: '^/api/(.*)$', replace: '/$1' },
}
```

```ts
{
  type: 'rewrite',
  config: { mode: 'cel_rewrite', expression: "'/v2' + PathValue()" },
}
```

## Notes

- If the generated value does not start with `/`, the middleware prefixes `/`.
- Scheme and authority from the original URI are preserved.
- If no rewrite value is produced, the request continues unchanged.
