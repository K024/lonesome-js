# `request_headers`

Mutates the upstream request headers after route matching and before proxying to upstream.

## Config

```ts
{
  type: 'request_headers',
  config: {
    name: string,
    action: 'append' | 'set' | 'set_default' | 'remove',
    value?: string,
    expression?: string,
    rule?: string,
  },
}
```

Actions:
- `append`: append a header value.
- `set`: replace existing values with the new value.
- `set_default`: set only when the header is absent.
- `remove`: remove the header.

Value source:
- `value`: static string value.
- `expression`: CEL expression that must return a string.

`append`, `set`, and `set_default` require exactly one of `value` or `expression`. `remove` allows neither.

## Examples

```ts
{ type: 'request_headers', config: { name: 'x-route', action: 'set', value: 'api' } }
```

```ts
{
  type: 'request_headers',
  config: {
    name: 'x-request-key',
    action: 'set',
    expression: "MethodValue() + ':' + PathValue()",
  },
}
```

## Notes

- The downstream request object is not modified; only the request sent to upstream is changed.
- Header names must not be empty.
