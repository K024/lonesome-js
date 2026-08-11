import { useEffect, useState } from 'preact/hooks'
import { highlight, type HighlightLanguage } from '../lib/highlight'

interface CodeBlockProps {
  value: string
  language?: HighlightLanguage
  className?: string
  maxHeight?: string
}

export function CodeBlock(
  { value, language = 'typescript', className, maxHeight }: CodeBlockProps,
) {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setHtml(null)
    void highlight(value, language).then((result) => {
      if (!cancelled) setHtml(result)
    })
    return () => {
      cancelled = true
    }
  }, [value, language])

  return (
    <pre
      class={`overflow-auto rounded-box border border-base-300 bg-neutral p-4 font-mono text-sm leading-relaxed text-neutral-content ${
        maxHeight ?? ''
      } ${className ?? ''}`}
      {...(html !== null ? { dangerouslySetInnerHTML: { __html: html } } : {})}
    >
      {html === null ? value : null}
    </pre>
  )
}
