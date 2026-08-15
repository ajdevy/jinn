import { createElement, Fragment, useRef, type ReactElement, type ReactNode } from 'react'
import { formatMessage, TRACE_OPEN_RE, TRACE_TAGS } from './message-markdown'

/**
 * Incremental markdown formatting for the streaming bubble.
 *
 * `formatMessage` is O(buffer) and the streaming bubble used to run it over the
 * whole buffer on every token, so per-token cost grew through a long reply — the
 * main-thread work that leaves a compositor waiting mid-flick.
 *
 * A stream only ever appends, so most of the buffer stops changing long before
 * the reply ends. This splits it at the last line where no multi-line construct
 * is open, formats each newly-settled run ONCE, and re-formats only the volatile
 * tail. The settled runs are handed back as the same React elements every time,
 * so React skips their subtrees too.
 *
 * The split is only sound where `formatMessage` is line-local, which is why
 * `stableLineCount` mirrors that function's own loop rather than approximating
 * it: a boundary inside a fence, a trace block or a table would render
 * differently split than whole, and the visible output has to be identical.
 */

/**
 * Close unclosed markdown tokens so partial content renders cleanly.
 * Handles: code blocks (```), inline code (`), bold (**), italic (*).
 */
export function closePartialMarkdown(text: string): string {
  let result = text

  // Count triple backticks — if odd, close the code block
  const tripleBackticks = (result.match(/```/g) || []).length
  if (tripleBackticks % 2 !== 0) {
    result += '\n```'
  }

  // Only fix inline markers outside of code blocks
  if (tripleBackticks % 2 === 0) {
    // Count inline backticks outside code blocks (simplified: count ` not part of ```)
    const withoutCodeBlocks = result.replace(/```[\s\S]*?```/g, '')
    const inlineBackticks = (withoutCodeBlocks.match(/`/g) || []).length
    if (inlineBackticks % 2 !== 0) {
      result += '`'
    }

    // Count ** pairs
    const boldMarkers = (withoutCodeBlocks.match(/\*\*/g) || []).length
    if (boldMarkers % 2 !== 0) {
      result += '**'
    }
  }

  return result
}

/** The trace tag this line opens, if it opens one `formatMessage` would fold. */
function traceTagAt(line: string): string | null {
  const open = line.trim().match(TRACE_OPEN_RE)
  const tag = open?.[1].toLowerCase()
  return tag && TRACE_TAGS.has(tag) ? tag : null
}

/**
 * Index of the line closing a trace block opened at `from`, or `lines.length`
 * when it is still open — an unterminated block runs to the end of the message
 * and keeps growing with the stream, so nothing after it can settle.
 */
function traceCloseIndex(lines: string[], from: number, tag: string): number {
  const closing = `</${tag}>`
  let i = from + 1
  while (i < lines.length && lines[i].trim().toLowerCase() !== closing) i++
  return i
}

/** A pipe line may still turn into a table header when its separator arrives, and
 *  a table's rows only render through the header that consumed them. */
function isPipeLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('|') && trimmed.endsWith('|')
}

/**
 * The last line that can ever settle. Never the line still being written; and
 * never a lone trailing empty one, because `formatMessage('')` renders nothing
 * while an empty line inside a longer buffer renders a spacer.
 */
function lastSettleableIndex(lines: string[]): number {
  const last = lines.length - 1
  return lines[last] === '' ? last - 1 : last
}

/**
 * How many leading lines are settled — final in content AND self-contained, so
 * formatting them apart from the rest renders exactly what formatting the whole
 * buffer would. Resumable: `from` must itself be a boundary this returned, and
 * the scan restarts there with clean state, which is what makes a token cost the
 * lines it added rather than the lines so far.
 *
 * The walk mirrors `formatMessage`'s own loop; anywhere it stopped mirroring it,
 * a split would render differently from the whole.
 */
export function stableLineCount(lines: string[], from = 0): number {
  const maxStable = lastSettleableIndex(lines)
  let stable = from
  let inCode = false
  let i = from
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('```')) {
      inCode = !inCode
    } else if (!inCode) {
      const tag = traceTagAt(line)
      if (tag) i = traceCloseIndex(lines, i, tag)
      if (i >= lines.length) break
    }
    if (!inCode && !isPipeLine(lines[i]) && i + 1 <= maxStable) stable = i + 1
    i++
  }
  return stable
}

export interface StreamingFormatterStats {
  /** Lines the markdown formatter has been run over, cumulative. */
  linesFormatted: number
}

export interface StreamingFormatter {
  /** The rendered buffer. Settling is idempotent, so calling twice with the same
   *  buffer returns the same tree rather than appending a second copy of it. */
  format: (buffer: string) => ReactElement
  stats: StreamingFormatterStats
}

export function createStreamingFormatter(): StreamingFormatter {
  const stats: StreamingFormatterStats = { linesFormatted: 0 }
  let settled: ReactNode[] = []
  let settledText = ''
  let settledLines = 0

  const formatRun = (text: string): ReactNode => {
    stats.linesFormatted += text.split('\n').length
    return formatMessage(text)
  }

  const format = (buffer: string): ReactElement => {
    // A buffer that does not continue what we settled is a different stream.
    if (!buffer.startsWith(settledText)) {
      settled = []
      settledText = ''
      settledLines = 0
    }
    const lines = buffer.split('\n')
    const stable = stableLineCount(lines, settledLines)
    if (stable > settledLines) {
      const run = lines.slice(settledLines, stable).join('\n')
      settled = [...settled, createElement(Fragment, { key: settledLines }, formatRun(run))]
      settledLines = stable
      settledText = lines.slice(0, stable).join('\n')
    }
    const closed = closePartialMarkdown(buffer)
    const tail = closed.slice(settledLines > 0 ? settledText.length + 1 : 0)
    return createElement(Fragment, null, settled, createElement(Fragment, { key: 'tail' }, formatRun(tail)))
  }

  return { format, stats }
}

/** One formatter per streaming bubble, kept across its tokens. */
export function useStreamingFormat(buffer: string): ReactElement {
  const formatter = useRef<StreamingFormatter | null>(null)
  formatter.current ??= createStreamingFormatter()
  return formatter.current.format(buffer)
}
