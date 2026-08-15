import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { formatMessage } from '../message-markdown'
import { closePartialMarkdown, createStreamingFormatter, stableLineCount } from '../streaming-format'

/**
 * The incremental formatter exists to stop the streaming bubble re-formatting its
 * whole buffer on every token. It is only safe if it is invisible, so the suite is
 * built the same way twice: what the reader sees must be byte-identical to the
 * whole-buffer formatter, and the work must not be.
 */

function wholeBufferHtml(buffer: string): string {
  const { container } = render(<div>{formatMessage(closePartialMarkdown(buffer))}</div>)
  return container.innerHTML
}

/** Feed the buffer through the formatter one chunk at a time, as a stream does. */
function streamedHtml(buffer: string, chunk = 7): string {
  const formatter = createStreamingFormatter()
  formatter.format('')
  for (let end = 1; end < buffer.length; end += chunk) formatter.format(buffer.slice(0, end))
  const { container } = render(<div>{formatter.format(buffer)}</div>)
  return container.innerHTML
}

const BUFFERS: Array<[string, string]> = [
  ['plain prose', 'Here is a plain answer.\nIt runs to two lines.'],
  ['an unclosed code fence', 'Before the block:\n\n```ts\nconst x = 1\nconst y = 2'],
  ['a closed code fence followed by prose', '```ts\nconst x = 1\n```\nAnd then some prose.'],
  ['an unclosed list', 'Steps:\n- first\n- second\n- thi'],
  ['an unclosed link', 'See [the docs](https://example.com/a) and [the other'],
  ['an unclosed bold run', 'This is **very import'],
  ['an unclosed inline code span', 'Run `pnpm buil'],
  ['a table', 'Results:\n\n| Name | Value |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n\nDone.'],
  ['a table still being written', 'Results:\n\n| Name | Value |\n| --- | --- |\n| a | 1 |'],
  ['a reasoning trace block', '<analysis>\nWeighing it up.\n</analysis>\nHere is the answer.'],
  ['an unterminated trace block', 'Working.\n<thinking>\nStill going and go'],
  ['headings and blank lines', '# Title\n\n## Section\n\nBody text.\n\n### Detail\n\n'],
  ['a trailing newline', 'One line.\n'],
  ['a single character', 'H'],
]

describe('streaming-format — output parity with the whole-buffer formatter', () => {
  for (const [name, buffer] of BUFFERS) {
    it(`renders ${name} identically`, () => {
      expect(streamedHtml(buffer)).toBe(wholeBufferHtml(buffer))
    })
  }

  it('renders a 4000-character buffer identically', () => {
    const paragraphs = Array.from(
      { length: 46 },
      (_, i) => `Paragraph ${i} carries **bold** text, a \`code\` span and a [link](https://example.com/${i}).`,
    )
    const buffer = paragraphs.join('\n\n')
    expect(buffer.length).toBeGreaterThan(4000)
    expect(streamedHtml(buffer, 97)).toBe(wholeBufferHtml(buffer))
  })
})

describe('streaming-format — the stable prefix is formatted once', () => {
  const lines = Array.from(
    { length: 120 },
    (_, i) => `Line ${i} with **bold** text and a \`code\` span.`,
  )

  it('does not re-run the formatter over the stable prefix on the next token', () => {
    const formatter = createStreamingFormatter()
    let buffer = ''
    for (const line of lines) {
      buffer += (buffer ? '\n' : '') + line
      formatter.format(buffer)
    }
    const before = formatter.stats.linesFormatted
    formatter.format(`${buffer} and one more token`)
    // The volatile tail is the line still being written, not the 119 above it.
    expect(formatter.stats.linesFormatted - before).toBeLessThanOrEqual(2)
  })

  it('keeps total formatting work linear in the stream, not quadratic', () => {
    const formatter = createStreamingFormatter()
    let buffer = ''
    for (const line of lines) {
      buffer += (buffer ? '\n' : '') + line
      formatter.format(buffer)
    }
    // Whole-buffer formatting would cost 1+2+...+120 = 7260 lines of work.
    expect(formatter.stats.linesFormatted).toBeLessThan(3 * lines.length)
  })
})

describe('stableLineCount', () => {
  it('never treats the line still being written as stable', () => {
    expect(stableLineCount(['done', 'still typ'])).toBe(1)
  })

  it('holds everything back while a code fence is open', () => {
    expect(stableLineCount(['intro', '```ts', 'const x = 1'])).toBe(1)
  })

  it('releases the whole block once the fence closes', () => {
    expect(stableLineCount(['intro', '```ts', 'const x = 1', '```', 'after'])).toBe(4)
  })

  it('holds a pipe line back, because its separator may still be coming', () => {
    expect(stableLineCount(['intro', '| a | b |', '| --- | --- |', 'x'])).toBe(1)
  })

  it('holds everything back while a trace block is unterminated', () => {
    expect(stableLineCount(['intro', '<thinking>', 'mulling', 'more'])).toBe(1)
  })

  it('leaves a lone trailing empty line in the volatile tail', () => {
    // `formatMessage('')` renders nothing, but an empty line inside a longer
    // buffer renders a spacer — so the tail may never be just that one line.
    expect(stableLineCount(['one', 'two', ''])).toBe(1)
  })

  it('resumes from a known-stable boundary without rescanning', () => {
    const lines = ['a', 'b', 'c', 'd']
    expect(stableLineCount(lines, 2)).toBe(3)
  })
})
