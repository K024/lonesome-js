import { useState } from 'preact/hooks'
import { api } from '../api'
import { CodeBlock } from '../components/CodeBlock'
import { PageHeader } from '../components/PageHeader'

type Mode = 'rule' | 'expression' | 'analyze'

const MODES: Mode[] = ['rule', 'expression', 'analyze']

const MODE_HINT: Record<Mode, string> = {
  rule: 'Evaluates a route matcher rule against a synthetic request.',
  expression: 'Evaluates any CEL expression against a synthetic request.',
  analyze:
    'Static rule analysis — parses the rule and reports on its structure, no request needed.',
}

export function DiagnosticsView() {
  const [mode, setMode] = useState<Mode>('rule')
  const [input, setInput] = useState("PathPrefix('/hello') && Method('GET')")
  const [method, setMethod] = useState('GET')
  const [path, setPath] = useState('/hello?debug=1')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)

  async function run(): Promise<void> {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await api.cel(
        mode === 'analyze'
          ? { mode, input }
          : { mode, input, request: { method, path } },
      )
      if (res.error) {
        setError(res.error)
      } else {
        setResult({
          analyze: res.analyze,
          evaluation: res.evaluation,
          result: res.result,
        })
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class='space-y-5'>
      <PageHeader
        title='CEL diagnostics'
        description="Test route matcher rules, arbitrary CEL expressions, and static rule analysis in the runtime's CEL engine."
      />

      <div class='card border border-base-300 bg-base-100 shadow-sm'>
        <div class='card-body space-y-4'>
          <div role='tablist' class='tabs tabs-box tabs-sm w-fit'>
            {MODES.map((m) => (
              <button
                key={m}
                role='tab'
                class={`tab min-w-24 ${mode === m ? 'tab-active' : ''}`}
                onClick={() => setMode(m)}
              >
                {m}
              </button>
            ))}
          </div>

          <fieldset class='fieldset'>
            <legend class='fieldset-legend'>Expression</legend>
            <p class='label'>{MODE_HINT[mode]}</p>
            <textarea
              class='textarea h-24 w-full font-mono'
              value={input}
              onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
            />
          </fieldset>

          {mode !== 'analyze' && (
            <div class='grid gap-3 sm:grid-cols-2'>
              <fieldset class='fieldset'>
                <legend class='fieldset-legend'>Method</legend>
                <select
                  class='select w-full'
                  value={method}
                  onChange={(e) =>
                    setMethod((e.target as HTMLSelectElement).value)}
                >
                  <option>GET</option>
                  <option>POST</option>
                  <option>PUT</option>
                  <option>DELETE</option>
                  <option>PATCH</option>
                </select>
              </fieldset>
              <fieldset class='fieldset'>
                <legend class='fieldset-legend'>Request path</legend>
                <input
                  class='input w-full font-mono'
                  value={path}
                  onInput={(e) => setPath((e.target as HTMLInputElement).value)}
                />
              </fieldset>
            </div>
          )}

          <div class='flex items-center gap-3'>
            <button
              class='btn btn-primary'
              disabled={busy}
              onClick={() => void run()}
            >
              {busy ? 'Evaluating…' : 'Evaluate'}
            </button>
            {busy && <span class='loading loading-spinner loading-sm'></span>}
          </div>
        </div>
      </div>

      {error && (
        <div role='alert' class='alert alert-error'>
          <span class='break-all font-mono text-sm'>{error}</span>
        </div>
      )}

      {result !== null && (
        <div class='card border border-base-300 bg-base-100 shadow-sm'>
          <div class='card-body'>
            <div class='flex items-center justify-between gap-2'>
              <h3 class='card-title text-sm'>Result</h3>
              <span class='badge badge-soft badge-sm font-mono'>{mode}</span>
            </div>
            <div class='pt-1'>
              <CodeBlock
                value={JSON.stringify(result, null, 2)}
                language='json'
                maxHeight='max-h-96'
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
