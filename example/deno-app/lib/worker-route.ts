import type { WorkerAddress, WorkerDef, WorkerUpstream } from './types.ts'

export function routeIdFor(name: string): string {
  return `wrk-${name}`
}

export function lazyInterceptorKeyFor(name: string): string {
  return `lazy-${name}`
}

export function instanceKey(name: string, replica: number): string {
  return `${name}#${replica}`
}

export function requireAddress(worker: WorkerDef): WorkerAddress {
  if (!worker.address) {
    throw new Error(`worker ${worker.name} has no assigned address`)
  }
  return worker.address
}

export function requireAddresses(worker: WorkerDef): WorkerAddress[] {
  if (worker.addresses && worker.addresses.length > 0) return worker.addresses
  return [requireAddress(worker)]
}

export function upstreamsFor(worker: WorkerDef): WorkerUpstream[] {
  return requireAddresses(worker).map(upstreamFromAddress)
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
