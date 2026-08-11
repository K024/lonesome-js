import { signal } from '@preact/signals'
import { api, type LogEntry, setAuthToken, type Snapshot } from './api'

export type ViewId = 'functions' | 'logs' | 'diagnostics' | 'docs'

export const view = signal<ViewId>('functions')
export const snapshot = signal<Snapshot | null>(null)
export const logs = signal<LogEntry[]>([])
export const detailFunction = signal<string | null>(null)
export const apiError = signal<string | null>(null)
export const authToken = signal(localStorage.getItem('lake-admin-token') ?? '')

let lastLogTs = 0

export function applyToken(value: string): void {
  setAuthToken(value)
  authToken.value = value
}

export async function refreshStatus(): Promise<void> {
  try {
    snapshot.value = await api.status()
    apiError.value = null
  } catch (err) {
    apiError.value = String(err)
  }
}

export async function refreshLogs(): Promise<void> {
  try {
    const entries = await api.logs(
      undefined,
      lastLogTs > 0 ? lastLogTs : undefined,
    )
    if (entries.length === 0) return
    const seen = new Set(logs.value.map(logKey))
    const fresh = entries.filter((entry) => !seen.has(logKey(entry)))
    lastLogTs = Math.max(lastLogTs, ...entries.map((entry) => entry.ts))
    if (fresh.length > 0) logs.value = [...logs.value, ...fresh].slice(-2000)
  } catch {
    // status refresh reports connectivity
  }
}

function logKey(entry: LogEntry): string {
  return `${entry.ts}:${entry.source}:${entry.level}:${entry.message}`
}

export function startPolling(): void {
  void refreshStatus()
  void refreshLogs()
  setInterval(() => {
    void refreshStatus()
    void refreshLogs()
  }, 3000)
}
