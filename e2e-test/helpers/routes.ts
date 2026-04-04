import type { LonesomeServer, NapiRouteConfig, NapiUpstreamConfig } from '../../dist/index.js'

let _seq = 0

/** Generate a globally unique route ID to avoid collisions within a test file */
export function nextRouteId(prefix = 'test'): string {
  return `${prefix}-${++_seq}`
}

/** TCP upstream config pointing at a given port */
export function tcpUpstream(port: number): NapiUpstreamConfig[] {
  return [{ kind: 'tcp', address: `127.0.0.1:${port}`, tls: false, sni: '', weight: 1 }]
}

/** Virtual-JS upstream config */
export function virtualUpstream(key: string): NapiUpstreamConfig[] {
  return [{ kind: 'virtual_js', address: key, tls: false, sni: '', weight: 1 }]
}

export function addRoute(server: LonesomeServer, config: NapiRouteConfig): void {
  server.addOrUpdate(config)
}

export function removeRoute(server: LonesomeServer, id: string): boolean {
  return server.remove(id)
}

/**
 * Register a route and return a cleanup function.
 * Designed for use inside test after() hooks.
 *
 * @example
 * let cleanup: () => void
 * before(() => { cleanup = withRoute(server, { id, matcher, middlewares, upstreams }) })
 * after(() => cleanup())
 */
export function withRoute(server: LonesomeServer, config: NapiRouteConfig): () => void {
  server.addOrUpdate(config)
  return () => server.remove(config.id)
}
