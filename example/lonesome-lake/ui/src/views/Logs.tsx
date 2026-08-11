import { useState } from 'preact/hooks'
import type { LogEntry } from '../api'
import { logs } from '../signals'
import { EmptyState } from '../components/EmptyState'
import { PageHeader } from '../components/PageHeader'
import { InboxIcon } from '../components/icons'
import { formatLogTime } from '../lib/format'

const LEVEL_BADGE: Record<LogEntry['level'], string> = {
  info: 'badge-soft badge-info',
  warn: 'badge-soft badge-warning',
  error: 'badge-soft badge-error',
}

type LevelFilter = 'all' | LogEntry['level']

const FILTERS: Array<{ id: LevelFilter; label: string }> = [
  { id: 'all', label: 'all' },
  { id: 'info', label: 'info' },
  { id: 'warn', label: 'warn' },
  { id: 'error', label: 'error' },
]

export function LogsView() {
  const [filter, setFilter] = useState<LevelFilter>('all')
  const entries = logs.value
  const rows = [...entries]
    .reverse()
    .filter((entry) => filter === 'all' || entry.level === filter)
  const shown = rows.length

  return (
    <div class='space-y-5'>
      <PageHeader
        title='Logs'
        description='Ring buffer of recent runtime and function log lines, newest first.'
      >
        <div class='join'>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              class={`btn btn-xs join-item min-w-20 ${
                filter === f.id ? 'btn-active' : ''
              }`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </PageHeader>

      <div class='card border border-base-300 bg-base-100 shadow-sm'>
        <div class='card-body'>
          <div class='flex flex-wrap items-center justify-between gap-2'>
            <h2 class='card-title text-lg'>Recent log lines</h2>
            <span class='badge badge-soft badge-sm'>{shown} entries</span>
          </div>

          {shown === 0
            ? (
              <EmptyState
                title={entries.length === 0
                  ? 'No log lines yet'
                  : 'No lines match this filter'}
                description={entries.length === 0
                  ? 'Runtime and function logs will appear here as they are emitted.'
                  : 'Try a different level filter.'}
                icon={<InboxIcon className='size-8' />}
              />
            )
            : (
              <div class='mt-2 max-h-[65vh] overflow-auto'>
                <table class='table table-sm table-pin-rows'>
                  <thead>
                    <tr>
                      <th>time</th>
                      <th>level</th>
                      <th>source</th>
                      <th>message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((entry, idx) => (
                      <tr key={`${entry.ts}-${idx}`}>
                        <td class='font-mono text-xs opacity-60'>
                          {formatLogTime(entry.ts)}
                        </td>
                        <td>
                          <span
                            class={`badge badge-xs ${LEVEL_BADGE[entry.level]}`}
                          >
                            {entry.level}
                          </span>
                        </td>
                        <td class='font-mono text-xs'>{entry.source}</td>
                        <td
                          class={`break-all font-mono text-xs ${
                            entry.level === 'error' ? 'text-error' : ''
                          }`}
                        >
                          {entry.message}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      </div>
    </div>
  )
}
