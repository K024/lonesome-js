# Interceptor Middleware

`interceptor` is a route middleware that calls a JavaScript handler before proxying. It can either continue the request or short-circuit it with a response.

## JavaScript API

```ts
registerInterceptor(
  key: string,
  interceptor: (request: {
    key: string
    method: string
    path: string
  }) => Promise<void | null | { action?: 'continue' } | { action: 'respond', status?: number, body?: string, contentType?: string }>,
): void

unregisterInterceptor(key: string): boolean
```

## Route Middleware Config

Pair middleware config and JS registration with the same `key`:

```ts
{
  type: 'interceptor',
  config: { key: 'my-interceptor' },
}
```

Behavior:
- If no JS handler is registered for `key`, the middleware continues by default.
- Return `undefined`, `null`, or `{ action: 'continue' }` to continue proxying.
- Return `{ action: 'respond', status, body, contentType }` to write a downstream response and skip upstream proxying.
- Duplicate registration for the same key is rejected.
- If the interceptor throws/rejects, the request fails before upstream selection.

## Example

```ts
import { registerInterceptor } from 'lonesome-js'

registerInterceptor('auth-gate', async ({ method, path }) => {
  if (method === 'GET' && path.startsWith('/public')) {
    return { action: 'continue' }
  }

  return {
    action: 'respond',
    status: 403,
    body: 'forbidden',
    contentType: 'text/plain; charset=utf-8',
  }
})
```
