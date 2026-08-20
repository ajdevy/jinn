import { CodeBlockChrome } from '@/components/code-block-chrome'

/* Fenced code blocks: reading the language off the fence line, and rendering
 * the block itself. */

// Parse the language label off a ```fence line. Returns lowercased first token
// (e.g. ```tsx {3-5} → "tsx"), or '' for a bare ``` fence.
export function parseFenceLang(line: string): string {
  const after = line.replace(/^```/, '').trim()
  if (!after) return ''
  return after.split(/\s+/)[0].toLowerCase()
}

export function CodeBlock({ code, lang, keyProp }: { code: string; lang?: string; keyProp: number }) {
  return (
    <CodeBlockChrome key={keyProp} code={code} language={lang} className="my-[var(--space-2)]">
      <pre className="code-block overflow-x-auto py-[var(--space-3)] px-[var(--space-4)] text-[length:var(--text-footnote)] leading-normal font-[family-name:var(--font-code)] text-[var(--text-primary)]"><code>{code}</code></pre>
    </CodeBlockChrome>
  )
}
