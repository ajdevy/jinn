/**
 * What one streaming token costs on a long transcript.
 *
 * `MessageRow` is memoised, so the cost of a token is decided entirely by prop
 * identity. The harness reproduces the production shape — chat-pane passes a
 * fresh `onRetry` arrow on every render — and counts how many row bodies that
 * makes React execute.
 *
 * The counter is `stripAttachedFilesBlock`: chat-messages.tsx calls it
 * unconditionally once per MessageRow body and nowhere else, and it comes from
 * another module, so a counting passthrough gives an exact row-render count.
 * `formatMessage` would under-count — it sits behind a `useMemo` on the text,
 * which does not change during someone else's stream.
 */
import { render } from '@testing-library/react'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Message } from '@/lib/conversations'
import { ChatMessages } from '../chat-messages'

const counters = vi.hoisted(() => ({ rowRenders: 0 }))

vi.mock('@/lib/conversations', async () => {
  const actual = await vi.importActual<typeof import('@/lib/conversations')>('@/lib/conversations')
  return {
    ...actual,
    stripAttachedFilesBlock: (text: string) => {
      counters.rowRenders += 1
      return actual.stripAttachedFilesBlock(text)
    },
  }
})

const MESSAGE_COUNT = 500
const TOKEN_COUNT = 10
const STREAM_WORDS = ['Let', 'me', 'check', 'that', 'for', 'you', 'right', 'now', 'one', 'moment']

/** Stable identity, as in production: only `streamingText` changes per token. */
const MESSAGES: Message[] = Array.from({ length: MESSAGE_COUNT }, (_, i) => ({
  id: `m-${i}`,
  role: (i % 2 === 0 ? 'user' : 'assistant') as Message['role'],
  content: i % 2 === 0 ? `Question number ${i}` : `Answer number ${i} with a little prose.`,
  timestamp: 1_700_000_000_000 + i * 1000,
}))
const ARRIVALS = new Map()
const noop = (_text: string) => {}

/** Mirrors chat-pane.tsx: `onRetry={(t) => void handleSend(t)}`, a new arrow each render. */
function Harness({ streamingText }: { streamingText: string }) {
  return (
    <ChatMessages
      messages={MESSAGES}
      loading
      streamingText={streamingText}
      onRetry={(t) => void noop(t)}
      blockArrivals={ARRIVALS}
    />
  )
}

describe('chat transcript render cost', () => {
  it('leaves the transcript alone while a reply streams', () => {
    counters.rowRenders = 0
    const { rerender, unmount } = render(<Harness streamingText="" />)
    expect(counters.rowRenders).toBe(MESSAGE_COUNT) // mount renders every row once

    counters.rowRenders = 0
    const start = performance.now()
    for (let i = 1; i <= TOKEN_COUNT; i++) {
      act(() => { rerender(<Harness streamingText={STREAM_WORDS.slice(0, i).join(' ')} />) })
    }
    const elapsedMs = performance.now() - start
    const rowRenders = counters.rowRenders
    unmount()

    console.log(
      `[chat render cost] messages=${MESSAGE_COUNT} tokens=${TOKEN_COUNT}`
      + ` rowRenders=${rowRenders} rowRendersPerToken=${rowRenders / TOKEN_COUNT}`
      + ` elapsedMs=${elapsedMs.toFixed(2)}`,
    )

    // A token appends to the streaming bubble and touches nothing else. Any row
    // render here means a prop identity changed, which on a long transcript is
    // the whole transcript re-rendering per token.
    expect(rowRenders).toBe(0)
  }, 120_000)
})
