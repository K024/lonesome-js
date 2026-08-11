const BASE = '/admin/api'

let token = localStorage.getItem('lake-admin-token') ?? ''

export function setAuthToken(value: string): void {
  token = value
  if (value) localStorage.setItem('lake-admin-token', value)
  else localStorage.removeItem('lake-admin-token')
}

export function authToken(): string {
  return token
}

export interface FunctionStatus {
  name: string
  handler: string
  matcher: { rule: string; priority?: number }
  replicas: number
  readyReplicas: number
  lazy: boolean
  timeoutMs?: number
  status: 'ready' | 'spawning' | 'lazy' | 'degraded'
  addresses?: string[]
  permissions?: Record<string, unknown>
}

export interface Snapshot {
  uptimeSec: number
  server: { running: boolean; routeCount: number; listeners: string[] } | null
  functions: FunctionStatus[]
  routes: Array<{ name: string; routeId: string }>
  admin?: { listen?: string; hasToken: boolean }
}

export interface LogEntry {
  ts: number
  level: 'info' | 'warn' | 'error'
  source: string
  message: string
}

export interface FunctionDetail {
  config?: Record<string, unknown>
  handler?: string
}

export interface CelRequest {
  mode: 'rule' | 'expression' | 'analyze'
  input: string
  request?: {
    method: string
    path: string
    headers?: Array<{ name: string; value: string }>
  }
}

export interface InvokeRequest {
  path: string
  method?: string
  body?: string
  headers?: Record<string, string>
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (token) headers.set('x-admin-token', token)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  const res = await fetch(BASE + path, { ...init, headers })
  if (!res.ok) {
    let message = `${res.status}`
    try {
      const data = await res.json()
      if (data?.error) message = data.error
    } catch {
      // keep status message
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export const api = {
  status: () => request<Snapshot>('/status'),
  functions: () => request<FunctionStatus[]>('/functions'),
  functionDetail: (name: string) =>
    request<FunctionDetail>(`/functions/${encodeURIComponent(name)}`),
  logs: (source?: string, since?: number) => {
    const params = new URLSearchParams()
    if (source) params.set('source', source)
    if (since) params.set('since', String(since))
    const qs = params.toString()
    return request<LogEntry[]>(`/logs${qs ? `?${qs}` : ''}`)
  },
  reload: () => request<{ ok: boolean }>('/reload', { method: 'POST' }),
  invoke: (body: InvokeRequest) =>
    request<{ status: number; headers: Record<string, string>; body: string }>(
      '/invoke',
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),
  cel: (body: CelRequest) =>
    request<
      {
        error?: string
        result?: unknown
        analyze?: unknown
        evaluation?: unknown
      }
    >('/diagnostics/cel', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
}
