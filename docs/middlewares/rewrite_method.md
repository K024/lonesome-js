# `rewrite_method`

Changes the HTTP method before upstream proxying.

## Config

```ts
{
  type: 'rewrite_method',
  config: {
    method: string,
    rule?: string,
  },
}
```

Fields:
- `method`: target HTTP method. It must be a valid HTTP token.
- `rule`: optional CEL condition.

## Example

```ts
{
  type: 'rewrite_method',
  config: { method: 'POST', rule: "PathPrefix('/submit-as-post')" },
}
```

## Notes

- The downstream request method is changed before building the upstream request.
- Request body handling is not changed by this middleware.
