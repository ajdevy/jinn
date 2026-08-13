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
import { fireEvent, render } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '@/lib/conversations'
import { ChatMessages } from '../chat-messages'
import { installVirtualLayout } from './virtual-layout'

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
const ROW_H = 120
const VIEWPORT_H = 800
/** Window + overscan on both sides. Generous, and still nowhere near 500. */
const WINDOW_CEILING = 40

/** Stable identity, as in production: only `streamingText` changes per token. */
const MESSAGES: Message[] = Array.from({ length: MESSAGE_COUNT }, (_, i) => ({
  id: `m-${i}`,
  role: (i % 2 === 0 ? 'user' : 'assistant') as Message['role'],
  content: i % 2 === 0 ? `Question number ${i}` : `Answer number ${i} with a little prose.`,
  timestamp: 1_700_000_000_000 + i * 1000,
}))
/**
 * The same length as one long turn: the ask, its work, one final answer. The
 * work is a single fold region, so this thread is THREE render groups — a group
 * count would leave it unwindowed, and the fold would mount all 500 rows.
 */
const ONE_TURN: Message[] = [
  { id: 'u-1', role: 'user', content: 'Audit the repository.', timestamp: 1_700_000_000_000 },
  ...Array.from({ length: MESSAGE_COUNT - 2 }, (_, i) => ({
    id: `w-${i}`,
    role: 'assistant' as const,
    content: `Progress update number ${i}.`,
    timestamp: 1_700_000_001_000 + i * 1000,
  })),
  { id: 'a-1', role: 'assistant', content: 'Audit complete.', timestamp: 1_700_000_600_000 },
]
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

afterEach(() => { vi.restoreAllMocks() })

describe('chat transcript render cost', () => {
  it('mounts a window of rows, not the whole thread', () => {
    const layout = installVirtualLayout(ROW_H, VIEWPORT_H)
    counters.rowRenders = 0
    const { unmount } = render(<Harness streamingText="" />)

    const mounted = document.querySelectorAll('[data-message-id]').length
    console.log(`[chat render cost] messages=${MESSAGE_COUNT} mountedRows=${mounted}`
      + ` mountRowRenders=${counters.rowRenders}`)
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThan(WINDOW_CEILING)
    layout.release()
    unmount()
  })

  it('keeps one turn of folded evidence out of the DOM, and gives it back on demand', () => {
    const layout = installVirtualLayout(ROW_H, VIEWPORT_H)
    const { container, unmount } = render(
      <ChatMessages messages={ONE_TURN} loading={false} blockArrivals={ARRIVALS} />,
    )

    expect(container.querySelector('[data-fold][data-folded]')).toBeTruthy()
    const mounted = container.querySelectorAll('[data-message-id]').length
    console.log(`[chat render cost] oneTurnMessages=${ONE_TURN.length} mountedRows=${mounted}`)
    expect(mounted).toBeLessThan(WINDOW_CEILING)

    fireEvent.click(container.querySelector('[data-fold-summary]')!)
    expect(container.querySelector('[data-message-id="w-0"]')).toBeTruthy()
    layout.release()
    unmount()
  })

  it('costs a bounded number of row bodies to append a committed message', () => {
    const layout = installVirtualLayout(ROW_H, VIEWPORT_H)
    const { rerender, unmount } = render(
      <ChatMessages messages={MESSAGES} loading={false} onRetry={(t) => void noop(t)} blockArrivals={ARRIVALS} />,
    )

    counters.rowRenders = 0
    const grown = [...MESSAGES, {
      id: 'm-new', role: 'assistant' as const, content: 'One more answer.', timestamp: 1_700_000_600_000,
    }]
    act(() => {
      rerender(<ChatMessages messages={grown} loading={false} onRetry={(t) => void noop(t)} blockArrivals={ARRIVALS} />)
    })
    const rowRenders = counters.rowRenders
    layout.release()
    unmount()

    // Rows are memoised on facts about themselves, so an append neither mounts
    // the rest of the thread nor re-runs the rows it left alone. Before this,
    // every row took the whole message array and every append cost 500.
    console.log(`[chat render cost] appendRowRenders=${rowRenders}`)
    expect(rowRenders).toBeLessThan(WINDOW_CEILING)
  })

  it('leaves the transcript alone while a reply streams', () => {
    // With no layout the scrollport measures 0 and the window is empty, so a
    // zero row-render count would only say the rows were never there.
    const layout = installVirtualLayout(ROW_H, VIEWPORT_H)
    const { rerender, unmount } = render(<Harness streamingText="" />)
    const mounted = document.querySelectorAll('[data-message-id]').length
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThan(WINDOW_CEILING)

    counters.rowRenders = 0
    const start = performance.now()
    for (let i = 1; i <= TOKEN_COUNT; i++) {
      act(() => { rerender(<Harness streamingText={STREAM_WORDS.slice(0, i).join(' ')} />) })
    }
    const elapsedMs = performance.now() - start
    const rowRenders = counters.rowRenders
    layout.release()
    unmount()

    console.log(
      `[chat render cost] messages=${MESSAGE_COUNT} mountedRows=${mounted} tokens=${TOKEN_COUNT}`
      + ` rowRenders=${rowRenders} rowRendersPerToken=${rowRenders / TOKEN_COUNT}`
      + ` elapsedMs=${elapsedMs.toFixed(2)}`,
    )

    // A token appends to the streaming bubble and touches nothing else. Any row
    // render here means a prop identity changed, which on a long transcript is
    // the whole transcript re-rendering per token.
    expect(rowRenders).toBe(0)
  }, 120_000)
})
