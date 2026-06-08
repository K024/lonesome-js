# `basic_auth`

Protects a route with HTTP Basic authentication. When credentials are missing or invalid, the middleware short-circuits with `401` and a `WWW-Authenticate` challenge.

## Config

```ts
{
  type: 'basic_auth',
  config: {
    realm?: string,
    users: Array<{ name: string, password_hash: string }>,
    rule?: string,
  },
}
```

Fields:
- `realm`: challenge realm. Defaults to `restricted`.
- `users`: accepted users. Must not be empty.
- `users[].name`: username.
- `users[].password_hash`: password hash accepted by the Rust `password-auth` verifier.
- `rule`: optional CEL condition.

## Example

```ts
{
  type: 'basic_auth',
  config: {
    realm: 'Admin',
    users: [{ name: 'alice', password_hash: '$argon2id$...' }],
    rule: "PathPrefix('/admin')",
  },
}
```

## Notes

- The downstream request must send `Authorization: Basic <base64(username:password)>`.
- Passwords are verified against hashes; do not store plaintext passwords in route config.
- On failure, the response body is empty.
