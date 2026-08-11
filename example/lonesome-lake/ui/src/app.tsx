import type { JSX } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { api } from './api'
import {
  apiError,
  applyToken,
  authToken,
  refreshLogs,
  refreshStatus,
  snapshot,
  startPolling,
  view,
  type ViewId,
} from './signals'
import {
  CloseIcon,
  DiagnosticsIcon,
  DocsIcon,
  LogsIcon,
  MenuIcon,
  OverviewIcon,
  ReloadIcon,
  SettingsIcon,
  WavesIcon,
} from './components/icons'
import { formatUptime } from './lib/format'
import { Modal } from './components/Modal'
import { FunctionsView } from './views/Functions'
import { LogsView } from './views/Logs'
import { DiagnosticsView } from './views/Diagnostics'
import { DocsView } from './views/Docs'

const NAV: Array<
  {
    id: ViewId
    label: string
    icon: (p: { className?: string }) => JSX.Element
  }
> = [
  { id: 'functions', label: 'Overview', icon: OverviewIcon },
  { id: 'logs', label: 'Logs', icon: LogsIcon },
  { id: 'diagnostics', label: 'Diagnostics', icon: DiagnosticsIcon },
  { id: 'docs', label: 'Docs', icon: DocsIcon },
]

export function App() {
  useEffect(() => {
    startPolling()
  }, [])

  const err = apiError.value
  const current = view.value
  const currentMeta = NAV.find((item) => item.id === current) ?? NAV[0]

  async function reload(): Promise<void> {
    try {
      await api.reload()
      await refreshStatus()
    } catch {
      // connectivity errors are surfaced by the poller
    }
  }

  return (
    <div class='drawer lg:drawer-open'>
      <input id='ll-sidebar' type='checkbox' class='drawer-toggle' />

      <div class='drawer-content flex min-h-screen flex-col bg-base-200'>
        <header class='sticky top-0 z-30 border-b border-base-300 bg-base-100'>
          <div class='mx-auto flex min-h-16 w-full max-w-6xl items-center px-3 md:px-5'>
            <div class='navbar-start gap-1'>
              <label
                for='ll-sidebar'
                aria-label='Open menu'
                class='btn btn-ghost btn-circle drawer-button lg:hidden'
              >
                <MenuIcon />
              </label>
              <div class='breadcrumbs text-sm font-medium'>
                <ul>
                  <li class='hidden opacity-60 sm:inline-flex'>
                    lonesome-lake
                  </li>
                  <li class='font-semibold'>{currentMeta.label}</li>
                </ul>
              </div>
            </div>

            <div class='navbar-end gap-1 sm:gap-2'>
              <ProxyBadge />
              <button
                class='btn btn-ghost btn-sm'
                onClick={() => void reload()}
              >
                <ReloadIcon className='size-4' />
                <span class='hidden sm:inline'>Reload</span>
              </button>
              <SettingsDialog />
            </div>
          </div>
        </header>

        <main class='mx-auto w-full max-w-6xl flex-1 px-3 py-6 md:px-5'>
          {err && (
            <div role='alert' class='alert alert-error alert-soft mb-4 text-sm'>
              <span class='break-all'>{err}</span>
            </div>
          )}
          {current === 'functions' && <FunctionsView />}
          {current === 'logs' && <LogsView />}
          {current === 'diagnostics' && <DiagnosticsView />}
          {current === 'docs' && <DocsView />}
        </main>
      </div>

      <div class='drawer-side z-40'>
        <label for='ll-sidebar' aria-label='Close menu' class='drawer-overlay'>
        </label>
        <aside class='flex min-h-full w-64 flex-col border-r border-base-300 bg-base-100'>
          <div class='flex items-center gap-3 p-4'>
            <div class='flex size-10 items-center justify-center rounded-box bg-primary text-primary-content'>
              <WavesIcon className='size-6' />
            </div>
            <div class='min-w-0'>
              <div class='truncate font-semibold leading-tight'>
                lonesome-lake
              </div>
              <div class='truncate font-mono text-xs opacity-60'>
                homelab FaaS
              </div>
            </div>
          </div>

          <ul class='menu w-full grow gap-1 px-2 [--menu-active-bg:var(--color-base-300)] [--menu-active-fg:var(--color-base-content)]'>
            {NAV.map((item) => {
              const Icon = item.icon
              return (
                <li key={item.id}>
                  <button
                    class={`${
                      current === item.id ? 'menu-active' : ''
                    } hover:bg-base-300!`}
                    aria-current={current === item.id ? 'page' : undefined}
                    onClick={() => {
                      view.value = item.id
                      closeSidebar()
                    }}
                  >
                    <Icon className='size-5' />
                    {item.label}
                  </button>
                </li>
              )
            })}
          </ul>

          <div class='border-t border-base-300 p-4'>
            <SidebarStatus />
          </div>
        </aside>
      </div>
    </div>
  )
}

function closeSidebar(): void {
  const toggle = document.getElementById('ll-sidebar') as
    | HTMLInputElement
    | null
  if (toggle) toggle.checked = false
}

function ProxyBadge() {
  const running = snapshot.value?.server?.running
  return (
    <span class='badge badge-sm badge-ghost gap-2'>
      <span
        class={`size-2.5 shrink-0 rounded-full ${
          running === undefined
            ? 'bg-base-content/40'
            : running
            ? 'bg-success'
            : 'bg-error'
        }`}
      >
      </span>
      <span class='font-medium'>
        {running === undefined
          ? 'connecting…'
          : running
          ? 'proxy up'
          : 'proxy down'}
      </span>
    </span>
  )
}

function SidebarStatus() {
  const snap = snapshot.value
  if (!snap) {
    return <div class='skeleton h-12 w-full'></div>
  }
  const running = snap.server?.running ?? false
  return (
    <div class='space-y-2 text-xs'>
      <div class='flex items-center justify-between gap-2'>
        <span class='opacity-60'>proxy</span>
        <span
          class={`font-mono font-medium ${
            running ? 'text-success' : 'text-error'
          }`}
        >
          {running ? 'running' : 'stopped'}
        </span>
      </div>
      <div class='flex items-center justify-between gap-2'>
        <span class='opacity-60'>functions</span>
        <span class='font-mono font-medium'>{snap.functions.length}</span>
      </div>
      <div class='flex items-center justify-between gap-2'>
        <span class='opacity-60'>uptime</span>
        <span class='font-mono font-medium'>
          {formatUptime(snap.uptimeSec)}
        </span>
      </div>
      {snap.server && (
        <div class='truncate pt-1 font-mono text-xs opacity-50'>
          {snap.server.listeners.join(', ')}
        </div>
      )}
    </div>
  )
}

function SettingsDialog() {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const hasToken = authToken.value.length > 0

  function openDialog(): void {
    setValue(authToken.value)
    setOpen(true)
  }

  function save(): void {
    applyToken(value.trim())
    setOpen(false)
    void refreshStatus()
    void refreshLogs()
  }

  function close(): void {
    setOpen(false)
  }

  return (
    <>
      <div
        class={`tooltip tooltip-bottom ${hasToken ? '' : 'tooltip-info'}`}
        data-tip={hasToken ? 'Admin token set' : 'Set admin token'}
      >
        <button class='btn btn-ghost btn-sm' onClick={openDialog}>
          <SettingsIcon className='size-4' />
          <span class='hidden sm:inline'>Settings</span>
          {hasToken && <span class='size-2 rounded-full bg-success'></span>}
        </button>
      </div>

      <Modal open={open} onClose={close} className='max-w-md'>
        <div class='flex items-start justify-between gap-4'>
          <h3 class='text-lg font-bold'>Settings</h3>
          <button class='btn btn-circle btn-ghost btn-sm' onClick={close}>
            <CloseIcon className='size-4' />
          </button>
        </div>

        <fieldset class='fieldset mt-2'>
          <legend class='fieldset-legend'>Admin token</legend>
          <p class='label'>
            Sent as <code class='font-mono'>x-admin-token</code>{' '}
            on every admin API request.
          </p>
          <input
            class='input w-full font-mono'
            type='password'
            placeholder='••••••••••••'
            value={value}
            onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          />
          <p class='label'>
            Stored in your browser (localStorage). Leave empty to clear.
          </p>
        </fieldset>

        <div class='modal-action'>
          <button class='btn' onClick={close}>Cancel</button>
          <button class='btn btn-primary' onClick={save}>Save</button>
        </div>
      </Modal>
    </>
  )
}
