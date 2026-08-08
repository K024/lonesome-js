# Dynamic TLS Certificates

`lonesome-js` serves downstream TLS certificates from a runtime certificate
store, resolved per handshake by SNI. Certificates can be added, replaced, and
removed without restarting the proxy.

## Lookup Order

For each handshake, the SNI is matched against the store, then falls back:

```
exact host  ->  one-label wildcard  ->  global default ('*')  ->  listener static cert
```

- The **listener static cert** (`certPath`/`keyPath` from `start()`) is loaded
  into the OpenSSL acceptor at start and is the lowest-priority default.
- `updateCert('*', ...)` replaces the global default at runtime, overriding the
  static cert for any SNI that does not match a host or wildcard.
- A wildcard matches **exactly one label**: `*.example.com` covers
  `www.example.com` but not `a.b.example.com` (which needs an explicit
  `*.b.example.com` wildcard or an exact cert).

## API

```ts
server.updateCert(host: string, options: { certPem: string; keyPem: string; allowMismatch?: boolean }): void
server.removeCert(host: string): boolean
```

### `host` forms

| host | behavior |
|---|---|
| `'example.com'` | exact match for that hostname |
| `'*.example.com'` | one-label wildcard |
| `'*'` | global default certificate |

### Certificate/hostname match check

Unless `allowMismatch: true` is set, `updateCert` validates that the
certificate's SAN (or CN when no SAN is present) matches `host`:
- exact host requires a SAN/CN equal to the hostname;
- wildcard host requires a SAN/CN of `*.example.com`.

A mismatched certificate is rejected with an error.

### Hot updates

`updateCert` writes to the in-memory store; the next TLS handshake serves the
new certificate. `removeCert` removes a specific key (`'*'` clears the global
default) and subsequent handshakes fall back to the next matching layer.

## Cert-less TLS listeners

A TLS listener may be started without `certPath`/`keyPath`:

```ts
server.updateCert('*', { certPem, keyPem })
server.start({ listeners: [{ kind: 'tls', addr: '127.0.0.1:443' }] })
```

`start()` throws if a cert-less TLS listener is used before a global default
(`updateCert('*')`) exists. A cert-less listener logs a warning at startup and
answers handshakes entirely from the cert store; an unmatched SNI fails the
handshake.

## Example: one cert for a host and its subdomains

A single certificate with SANs `[example.com, *.example.com]` covers the bare
domain and every one-label subdomain. Register it once for the wildcard and once
for the bare domain (a wildcard does not cover the bare domain):

```ts
server.updateCert('*.example.com', { certPem, keyPem })
server.updateCert('example.com', { certPem, keyPem })
```

## Notes

- Certs are parsed at `updateCert` time (bad PEM is rejected immediately).
- The store is per `LonesomeServer` instance and shared by all its TLS
  listeners; each listener keeps its own static cert as the fallback.
- Requires the OpenSSL backend (the default build).
