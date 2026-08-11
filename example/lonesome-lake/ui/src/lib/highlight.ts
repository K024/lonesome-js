export type HighlightLanguage =
  | 'typescript'
  | 'javascript'
  | 'json'
  | 'yaml'
  | 'bash'

type PrismNamespace = typeof import('prismjs')

let prismPromise: Promise<PrismNamespace> | null = null

export function loadPrism(): Promise<PrismNamespace> {
  prismPromise ??= import('prismjs').then(async (mod) => {
    const prism = (mod as unknown as { default?: PrismNamespace }).default ??
      (mod as unknown as PrismNamespace)
    await Promise.all([
      import('prismjs/components/prism-typescript'),
      import('prismjs/components/prism-javascript'),
      import('prismjs/components/prism-json'),
      import('prismjs/components/prism-yaml'),
      import('prismjs/components/prism-bash'),
      import('prismjs/themes/prism-tomorrow.css'),
    ])
    return prism
  })
  return prismPromise
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(
    />/g,
    '&gt;',
  )
}

export async function highlight(
  code: string,
  language: HighlightLanguage,
): Promise<string> {
  const prism = await loadPrism()
  const grammar = prism.languages[language]
  if (!grammar) return escapeHtml(code)
  try {
    return prism.highlight(code, grammar, language)
  } catch {
    return escapeHtml(code)
  }
}
