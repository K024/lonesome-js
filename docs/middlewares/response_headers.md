# `response_headers`

Mutates response headers before they are sent downstream.

## Config

```ts
{
  type: 'response_headers',
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
{ type: 'response_headers', config: { name: 'x-powered-by', action: 'remove' } }
```

```ts
{
  type: 'response_headers',
  config: {
    name: 'x-route-path',
    action: 'set',
    expression: 'PathValue()',
  },
}
```

## Notes

- The middleware sees the response header after upstream response filters and before downstream write.
- Header names must not be empty.
