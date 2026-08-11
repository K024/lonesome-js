import type { FunctionDef, WorkerAddress, WorkerUpstream } from './types.ts'

export function routeIdFor(name: string): string {
  return `fn-${name}`
}

export function lazyInterceptorKeyFor(name: string): string {
  return `lazy-${name}`
}

export function instanceKey(name: string, replica: number): string {
  return `${name}#${replica}`
}

export function requireAddresses(def: FunctionDef): WorkerAddress[] {
  if (def.addresses && def.addresses.length > 0) return def.addresses
  throw new Error(`function ${def.name} has no assigned addresses`)
}

export function upstreamsFor(def: FunctionDef): WorkerUpstream[] {
  return requireAddresses(def).map(upstreamFromAddress)
}

export function formatAddress(address: WorkerAddress): string {
  return address.kind === 'unix'
    ? `unix:${address.path}`
    : `${address.hostname}:${address.port}`
}

function upstreamFromAddress(address: WorkerAddress): WorkerUpstream {
  return address.kind === 'unix'
    ? { kind: 'unix', address: address.path, tls: false, sni: '', weight: 1 }
    : {
      kind: 'tcp',
      address: `${address.hostname}:${address.port}`,
      tls: false,
      sni: '',
      weight: 1,
    }
}
