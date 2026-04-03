export type UpstreamSelection = 'tcp' | 'unix' | 'virtual_js' | 'respond'
export type RouteSelection = 'simple' | 'many'
export type PayloadSelection = 'tiny_hello' | 'medium_json'

export type BenchSetup = {
  upstream: UpstreamSelection
  route: RouteSelection
  payload: PayloadSelection
}

export type BenchRuntimeConfig = {
  host: string
  port: number
  path: string
  method: string
}
