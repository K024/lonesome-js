# `jwt`

Verifies JWT or decrypts JWE tokens using a JWKS document. Verified claims are made available to CEL expressions as `jwt_payload`.

## Config

```ts
{
  type: 'jwt',
  config: {
    header_name?: string,
    bearer_prefix?: string,
    jwks: string,
    validate_time?: boolean,
    on_error?: 'deny' | 'passthrough',
    rule?: string,
  },
}
```

Defaults:
- `header_name`: `authorization`
- `bearer_prefix`: `Bearer `
- `validate_time`: `false`
- `on_error`: `deny`

Fields:
- `jwks`: JWKS JSON string used to verify JWT signatures or decrypt JWE payloads.
- `validate_time`: validates `nbf` and `exp` claims against current time.
- `on_error`: `deny` returns `401`; `passthrough` lets the request continue without JWT claims.
- `rule`: optional CEL condition.

## Example

```ts
{
  type: 'jwt',
  config: {
    jwks: JSON.stringify({ keys: [/* JWKs */] }),
    validate_time: true,
    on_error: 'deny',
  },
}
```

Use verified claims later:

```ts
{
  type: 'request_headers',
  config: {
    name: 'x-user-sub',
    action: 'set',
    expression: "string(jwt_payload.sub)",
  },
}
```

## Notes

- JWT uses three compact segments; JWE uses five compact segments.
- If `bearer_prefix` is an empty string, the full header value is treated as the token.
