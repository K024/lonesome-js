# `set_variable`

Evaluates a CEL expression and stores the result as a CEL variable for later middleware expressions.

## Config

```ts
{
  type: 'set_variable',
  config: {
    name: string,
    expression: string,
    stage?: 'request' | 'upstream_response' | 'response',
    rule?: string,
  },
}
```

Defaults:
- `stage`: `request`

Fields:
- `name`: variable name.
- `expression`: CEL expression whose result is stored.
- `stage`: phase where the variable is computed.
- `rule`: optional CEL condition.

## Examples

```ts
{
  type: 'set_variable',
  config: { name: 'request_key', expression: "MethodValue() + ':' + PathValue()" },
}
```

```ts
{
  type: 'response_headers',
  config: { name: 'x-request-key', action: 'set', expression: 'request_key' },
}
```

## Stages

- `request`: runs during request filtering, before upstream selection.
- `upstream_response`: runs after upstream response headers are received.
- `response`: runs in the final response header phase before downstream write.

## Notes

- Later middlewares can read variables created by earlier middlewares in the same request.
- Place `set_variable` before consumers that need the variable.
