# `health_check`

Tracks upstream connection health and can retry failed upstream connects.

## Config

```ts
{
  type: 'health_check',
  config: {
    retries?: number,
    failure_window_ms?: number,
    max_attempts?: number,
    include_http_errors?: boolean,
  },
}
```

Defaults:
- `retries`: `0`
- `failure_window_ms`: `10000`
- `max_attempts`: `1`
- `include_http_errors`: `false`

Fields:
- `retries`: number of connect retries to mark as retryable after connect failure.
- `failure_window_ms`: rolling health observation window.
- `max_attempts`: failure threshold used by upstream health observation.
- `include_http_errors`: when true, upstream `5xx` responses are recorded as failures.

## Example

```ts
{
  type: 'health_check',
  config: {
    retries: 1,
    failure_window_ms: 5000,
    max_attempts: 2,
    include_http_errors: true,
  },
}
```

## Notes

- Only one `health_check` middleware may be active for a route request.
- Successful upstream connection marks the selected backend healthy.
- Failed upstream connection marks the selected backend unhealthy and may trigger retry behavior.
