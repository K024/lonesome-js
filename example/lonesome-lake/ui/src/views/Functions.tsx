import { useEffect, useState } from 'preact/hooks'
import { api, type FunctionDetail, type FunctionStatus } from '../api'
import { detailFunction, snapshot } from '../signals'
import { CodeBlock } from '../components/CodeBlock'
import { EmptyState } from '../components/EmptyState'
import { Modal } from '../components/Modal'
import { PageHeader } from '../components/PageHeader'
import { CloseIcon, InboxIcon } from '../components/icons'
import { formatUptime } from '../lib/format'

const STATUS_BADGE: Record<FunctionStatus['status'], string> = {
  ready: 'badge-soft badge-success',
  spawning: 'badge-soft badge-info',
  lazy: 'badge-soft badge-warning',
  degraded: 'badge-soft badge-error',
}

export function FunctionsView() {
  const snap = snapshot.value

  if (!snap) {
    return <OverviewSkeleton />
  }

  const readyCount = snap.functions.filter((fn) => fn.status === 'ready').length
  const total = snap.functions.length
  const pending = total - readyCount

  return (
    <div class='space-y-5'>
      <PageHeader
        title='Overview'
        description='Read-only snapshot of the runtime and its git-managed functions.'
      >
        <span class='hidden font-mono text-xs opacity-60 sm:inline'>
          refreshes every 3s
        </span>
      </PageHeader>

      <div class='stats stats-vertical w-full border border-base-300 bg-base-100 shadow-sm md:stats-horizontal'>
        <div class='stat'>
          <div class='stat-title'>Proxy</div>
          <div class='stat-value text-2xl'>
            {snap.server?.running ? 'running' : 'stopped'}
          </div>
          <div class='stat-desc'>
            {snap.server ? snap.server.listeners.join(', ') : 'no listener'}
          </div>
        </div>
        <div class='stat'>
          <div class='stat-title'>Functions</div>
          <div class='stat-value text-2xl'>{total}</div>
          <div class='stat-desc'>{readyCount} ready · {pending} pending</div>
        </div>
        <div class='stat'>
          <div class='stat-title'>Routes</div>
          <div class='stat-value text-2xl'>{snap.routes.length}</div>
          <div class='stat-desc'>
            {snap.server
              ? `${snap.server.routeCount} registered`
              : 'proxy down'}
          </div>
        </div>
        <div class='stat'>
          <div class='stat-title'>Uptime</div>
          <div class='stat-value text-2xl'>{formatUptime(snap.uptimeSec)}</div>
          <div class='stat-desc'>runtime since start</div>
        </div>
      </div>

      <div class='card border border-base-300 bg-base-100 shadow-sm'>
        <div class='card-body'>
          <div class='flex flex-wrap items-center justify-between gap-2'>
            <h2 class='card-title text-lg'>Functions</h2>
            <span class='text-xs opacity-60'>
              managed by git — drop a directory under{' '}
              <code class='font-mono'>functions/</code>
            </span>
          </div>

          {total === 0
            ? (
              <EmptyState
                title='No functions found'
                description='Add a directory under functions/ and hit Reload to re-scan.'
                icon={<InboxIcon className='size-8' />}
              />
            )
            : (
              <div class='mt-2 overflow-x-auto'>
                <table class='table table-sm'>
                  <thead>
                    <tr>
                      <th>name</th>
                      <th>status</th>
                      <th>matcher</th>
                      <th class='text-center'>replicas</th>
                      <th class='text-center'>lazy</th>
                      <th class='text-center'>timeout</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {snap.functions.map((fn) => (
                      <tr key={fn.name}>
                        <td class='font-mono font-medium'>{fn.name}</td>
                        <td>
                          <span
                            class={`badge badge-sm ${STATUS_BADGE[fn.status]}`}
                          >
                            {fn.status}
                          </span>
                        </td>
                        <td class='max-w-xs truncate font-mono text-xs opacity-70'>
                          {fn.matcher.rule}
                        </td>
                        <td class='text-center text-sm'>
                          {fn.readyReplicas}/{fn.replicas}
                        </td>
                        <td class='text-center'>{fn.lazy ? 'yes' : 'no'}</td>
                        <td class='text-center text-sm'>
                          {fn.timeoutMs ? `${fn.timeoutMs}ms` : '—'}
                        </td>
                        <td class='text-right'>
                          <button
                            class='btn btn-ghost btn-xs'
                            onClick={() => (detailFunction.value = fn.name)}
                          >
                            details
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      </div>

      <FunctionDetailModal />
    </div>
  )
}

function OverviewSkeleton() {
  return (
    <div class='space-y-5'>
      <div class='skeleton skeleton-text h-8 w-40'></div>
      <div class='grid gap-4 md:grid-cols-4'>
        {[0, 1, 2, 3].map((i) => <div key={i} class='skeleton h-24'></div>)}
      </div>
      <div class='skeleton h-80 w-full'></div>
    </div>
  )
}

function FunctionDetailModal() {
  const name = detailFunction.value
  const [lastName, setLastName] = useState<string | null>(null)
  const [detail, setDetail] = useState<FunctionDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [invokeMethod, setInvokeMethod] = useState('GET')
  const [invokePath, setInvokePath] = useState('')
  const [invokeResult, setInvokeResult] = useState<string | null>(null)
  const [invokeBusy, setInvokeBusy] = useState(false)

  useEffect(() => {
    if (!name) return
    let cancelled = false
    setLastName(name)
    setDetail(null)
    setLoadError(null)
    setInvokeResult(null)
    setInvokePath(`/${name}`)
    void (async () => {
      try {
        const result = await api.functionDetail(name)
        if (!cancelled) setDetail(result)
      } catch (err) {
        if (!cancelled) setLoadError(String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [name])

  const shownName = name ?? lastName
  const fn = snapshot.value?.functions.find((f) => f.name === shownName)

  function close(): void {
    detailFunction.value = null
  }

  async function invoke(): Promise<void> {
    setInvokeBusy(true)
    setInvokeResult(null)
    try {
      const result = await api.invoke({
        path: invokePath,
        method: invokeMethod,
      })
      const headerLine = Object.entries(result.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
      setInvokeResult(
        `HTTP ${result.status}${headerLine ? `\n${headerLine}` : ''}\n\n${
          result.body.slice(0, 4000)
        }`,
      )
    } catch (err) {
      setInvokeResult(`error: ${err}`)
    } finally {
      setInvokeBusy(false)
    }
  }

  return (
    <Modal open={name !== null} onClose={close} className='max-w-3xl'>
      {shownName && (
        <>
          <div class='flex items-center justify-between gap-3'>
            <div class='flex min-w-0 items-center gap-2'>
              <h3 class='truncate font-mono text-lg font-bold'>{shownName}</h3>
              {fn && (
                <span
                  class={`badge badge-sm shrink-0 ${STATUS_BADGE[fn.status]}`}
                >
                  {fn.status}
                </span>
              )}
            </div>
            <button
              class='btn btn-circle btn-ghost btn-sm shrink-0'
              onClick={close}
              aria-label='Close'
            >
              <CloseIcon className='size-4' />
            </button>
          </div>

          {loadError
            ? (
              <div role='alert' class='alert alert-error mt-4'>
                <span class='break-all text-sm'>{loadError}</span>
              </div>
            )
            : (
              <>
                {fn && <ConfigSummary fn={fn} />}

                {detail
                  ? (
                    <>
                      {detail.config && (
                        <ConfigDetails config={detail.config} />
                      )}
                      {detail.handler !== undefined && (
                        <div class='mt-4'>
                          <p class='label mb-1'>handler.ts</p>
                          <CodeBlock
                            value={detail.handler}
                            language='typescript'
                            maxHeight='max-h-80'
                          />
                        </div>
                      )}
                    </>
                  )
                  : (
                    <div class='mt-4 space-y-2'>
                      <div class='skeleton h-16 w-full'></div>
                      <div class='skeleton h-32 w-full'></div>
                    </div>
                  )}

                <div class='mt-5 border-t border-base-200 pt-4'>
                  <fieldset class='fieldset'>
                    <legend class='fieldset-legend'>Test invoke</legend>
                    <p class='label'>
                      Sends a synthetic request through the proxy (POST
                      /admin/api/invoke).
                    </p>
                    <div class='join w-full'>
                      <select
                        class='select select-sm join-item'
                        value={invokeMethod}
                        onChange={(e) =>
                          setInvokeMethod(
                            (e.target as HTMLSelectElement).value,
                          )}
                      >
                        <option>GET</option>
                        <option>POST</option>
                        <option>PUT</option>
                        <option>DELETE</option>
                        <option>PATCH</option>
                      </select>
                      <input
                        class='input input-sm join-item w-full min-w-0 flex-1 font-mono'
                        value={invokePath}
                        onInput={(e) =>
                          setInvokePath((e.target as HTMLInputElement).value)}
                      />
                      <button
                        class='btn btn-sm join-item'
                        disabled={invokeBusy}
                        onClick={() => void invoke()}
                      >
                        {invokeBusy ? 'running…' : 'Invoke'}
                      </button>
                    </div>
                    {invokeResult !== null && (
                      <div class='pt-1'>
                        <CodeBlock value={invokeResult} maxHeight='max-h-72' />
                      </div>
                    )}
                  </fieldset>
                </div>
              </>
            )}

          <div class='modal-action'>
            <button class='btn' onClick={close}>Close</button>
          </div>
        </>
      )}
    </Modal>
  )
}

function ConfigSummary({ fn }: { fn: FunctionStatus }) {
  return (
    <div class='mt-3 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2'>
      <div class='flex min-w-0 items-center gap-2'>
        <span class='shrink-0 opacity-60'>matcher</span>
        <code class='truncate font-mono text-xs opacity-90'>
          {fn.matcher.rule}
        </code>
      </div>
      <div class='flex items-center gap-2'>
        <span class='opacity-60'>priority</span>
        <span class='font-mono'>{fn.matcher.priority ?? '—'}</span>
      </div>
      <div class='flex items-center gap-2'>
        <span class='opacity-60'>replicas</span>
        <span class='font-mono'>{fn.readyReplicas}/{fn.replicas}</span>
      </div>
      <div class='flex items-center gap-2'>
        <span class='opacity-60'>lazy / timeout</span>
        <span class='font-mono'>
          {fn.lazy ? 'yes' : 'no'} / {fn.timeoutMs ? `${fn.timeoutMs}ms` : '—'}
        </span>
      </div>
      {fn.addresses && (
        <div class='flex flex-wrap items-center gap-2 sm:col-span-2'>
          <span class='opacity-60'>upstream</span>
          {fn.addresses.map((addr) => (
            <span key={addr} class='font-mono'>{addr}</span>
          ))}
        </div>
      )}
    </div>
  )
}

function ConfigDetails({ config }: { config: Record<string, unknown> }) {
  const env = config.env as Record<string, string> | undefined
  const permissions = config.permissions as Record<string, unknown> | undefined
  return (
    <>
      {env && Object.keys(env).length > 0 && (
        <div class='mt-4'>
          <p class='label mb-1'>env</p>
          <div class='flex flex-wrap gap-1'>
            {Object.entries(env).map(([k, v]) => (
              <span key={k} class='badge badge-soft badge-sm font-mono'>
                {k}={v}
              </span>
            ))}
          </div>
        </div>
      )}
      {permissions && (
        <div class='mt-4'>
          <p class='label mb-1'>permissions</p>
          <CodeBlock
            value={JSON.stringify(permissions, null, 2)}
            language='json'
            maxHeight='max-h-56'
          />
        </div>
      )}
    </>
  )
}
