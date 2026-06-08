# `respond`

Short-circuits the request with a fixed or computed response.

## Config

```ts
{
  type: 'respond',
  config: {
    status: number,
    content_type?: string,
    body?: string,
    body_expression?: string,
    rule?: string,
  },
}
```

Fields:
- `status`: response status. Must be in `[100, 999]`.
- `content_type`: optional `Content-Type` when a body is present. Defaults to `text/plain; charset=utf-8`.
- `body`: static body string.
- `body_expression`: CEL expression used to compute the body.
- `rule`: optional CEL condition.

`body` and `body_expression` cannot both be set.

## Examples

```ts
{ type: 'respond', config: { status: 204 } }
```

```ts
{
  type: 'respond',
  config: {
    status: 200,
    content_type: 'application/json',
    body_expression: "'{\"path\":\"' + PathValue() + '\"}'",
  },
}
```

## Notes

- If no body is produced, the response has `Content-Length: 0` and no default content type.
- `body_expression` may return a string, integer, unsigned integer, float, or boolean; scalar values are stringified.
