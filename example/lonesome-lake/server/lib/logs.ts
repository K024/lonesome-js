export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  ts: number
  level: LogLevel
  source: string
  message: string
}

export class LogRing {
  private readonly capacity: number
  private buffer: Array<LogEntry | null>
  private head = 0
  private tail = 0
  private size = 0

  constructor(capacity = 2000) {
    this.capacity = Math.max(1, capacity)
    this.buffer = new Array<LogEntry | null>(this.capacity)
  }

  push(level: LogLevel, source: string, message: string): void {
    this.buffer[this.tail] = { ts: Date.now(), level, source, message }
    this.tail = (this.tail + 1) % this.capacity
    if (this.size < this.capacity) {
      this.size++
    } else {
      this.head = (this.head + 1) % this.capacity
    }
  }

  list(opts?: { since?: number; source?: string }): LogEntry[] {
    const { since, source } = opts ?? {}
    const out: LogEntry[] = []
    for (let i = 0; i < this.size; i++) {
      const entry = this.buffer[(this.head + i) % this.capacity]
      if (!entry) continue
      if (since !== undefined && entry.ts < since) continue
      if (source !== undefined && entry.source !== source) continue
      out.push(entry)
    }
    return out
  }

  clear(): void {
    this.head = 0
    this.tail = 0
    this.size = 0
  }
}
