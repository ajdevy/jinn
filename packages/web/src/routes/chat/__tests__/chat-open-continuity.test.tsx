/**
 * Chat open continuity — the six open scenarios, measured rather than eyeballed.
 *
 * Every commit of the pane is recorded as a frame, so "one loading state" and
 * "never a spinner after content" are counted off the sequence instead of being
 * asserted from an impression. A loading state means a visible loading
 * affordance: the hydration spinner. The beat where the opening selection is
 * still resolving paints nothing at all, and is recorded as the absence of a
 * pane rather than as a loading state — which is exactly what it looks like.
 *
 * The surface below is the real wiring — usePaneIdentity, which owns the commit
 * lag, plus useLiveSession and useHydrationSpinner — with only the transport
 * faked. The spinner predicate is copied from chat-pane.tsx (search
 * `showSessionHydration`): the one line this harness restates, and it has to
 * stay in step.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useEffect } from 'react'
import { act, render } from '@testing-library/react'

const getSession = vi.fn()
vi.mock('@/lib/api', () => ({
  api: { getSession: (id: string, options?: unknown) => getSession(id, options) },
}))

import { isOpenSelectionInbound, SWITCH_HOLD_MS } from '../selection-commit'
import { usePaneIdentity } from '../pane-identity'
import { useHydrationSpinner } from '@/components/chat/chat-hydration'
import { __clearLiveSessionSnapshotCacheForTests, useLiveSession } from '@/hooks/use-live-session'
import type { GatewayEventListener } from '@jinn/gateway-events'

/** One committed paint of the pane. `pane: 'none'` never appears — a frame only
 *  exists when a pane is mounted, so an absent frame IS the withheld mount. */
interface Frame {
  sessionId: string | null
  content: boolean
  spinner: boolean
}

const SPINNER_THRESHOLD_MS = 250
/** Slower than the spinner threshold: a cold open genuinely shows its spinner. */
const SLOW_MS = 400
/** Faster than the switch hold: the destination can be warmed before it mounts. */
const FAST_MS = 100

let latencyMs = SLOW_MS
let frames: Frame[] = []

function subscribe(_listener: GatewayEventListener) {
  return () => {}
}

function transcript(id: string, rows: number) {
  return Array.from({ length: rows }, (_, i) => ({
    id: `${id}-m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `${id} row ${i}`,
    timestamp: 1_000 + i,
  }))
}

function Pane({ sessionId }: { sessionId: string | null }) {
  const { messages, hydrating, streamingText } = useLiveSession(sessionId, { subscribe })
  const spinner = useHydrationSpinner(Boolean(sessionId && hydrating && messages.length === 0 && !streamingText))
  useEffect(() => {
    frames.push({ sessionId, content: messages.length > 0, spinner })
  })
  return null
}

interface SurfaceProps {
  selectedId: string | null
  sessionsPending?: boolean
  sessionCount?: number
  newChatIntent?: boolean
}

/** The chat route's pane slot, with everything around it stripped away. */
function Surface({ selectedId, sessionsPending = false, sessionCount = 0, newChatIntent = false }: SurfaceProps) {
  const { paneKey, committedId, awaitingOpen } = usePaneIdentity(selectedId, null, {
    newChatIntent,
    sessionsPending,
    sessionCount,
  })
  if (awaitingOpen) return null
  return <Pane key={paneKey} sessionId={committedId} />
}

/** Number of times a spinner appeared — a run of spinner frames counts once. */
function loadingStates(recorded: Frame[]): number {
  let count = 0
  recorded.forEach((frame, i) => {
    if (frame.spinner && !recorded[i - 1]?.spinner) count += 1
  })
  return count
}

/** The defect this ticket exists for: content on screen, then a spinner over it. */
function spinnerAfterContent(recorded: Frame[]): boolean {
  const firstContent = recorded.findIndex((frame) => frame.content)
  return firstContent >= 0 && recorded.slice(firstContent).some((frame) => frame.spinner)
}

/** One jump of the fake clock coalesces every state update it triggers into a
 *  single React commit, which would hide the very frames this suite counts.
 *  Stepping in slices lets React commit between timers, the way real frames do. */
async function advance(ms: number) {
  for (let remaining = ms; remaining > 0; remaining -= 50) {
    await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(50, remaining)) })
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  frames = []
  latencyMs = SLOW_MS
  getSession.mockReset()
  getSession.mockImplementation((id: string) => new Promise((resolve) => {
    setTimeout(() => resolve({ id, status: 'idle', messages: transcript(id, 4) }), latencyMs)
  }))
  __clearLiveSessionSnapshotCacheForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('opening a chat', () => {
  it('holds the pane on a cold `/` until the auto-select lands, so the composer never paints', async () => {
    // Sessions still loading: nothing may mount.
    const { rerender } = render(<Surface selectedId={null} sessionsPending sessionCount={0} />)
    expect(frames).toHaveLength(0)

    // Sessions resolved, but the auto-select navigation has not landed yet —
    // the beat that used to mount the new-chat composer.
    rerender(<Surface selectedId={null} sessionCount={3} />)
    await advance(0)
    expect(frames).toHaveLength(0)

    rerender(<Surface selectedId="s1" sessionCount={3} />)
    await advance(SLOW_MS + SPINNER_THRESHOLD_MS)

    expect(frames.some((frame) => frame.sessionId === null)).toBe(false)
    expect(frames.at(-1)).toMatchObject({ sessionId: 's1', content: true, spinner: false })
    expect(loadingStates(frames)).toBe(1)
    expect(spinnerAfterContent(frames)).toBe(false)
  })

  it('opens the composer once the list resolves empty, because that is the real selection', async () => {
    const { rerender } = render(<Surface selectedId={null} sessionsPending sessionCount={0} />)
    expect(frames).toHaveLength(0)

    rerender(<Surface selectedId={null} sessionCount={0} />)
    await advance(0)

    expect(frames.at(-1)).toMatchObject({ sessionId: null, content: false, spinner: false })
    expect(loadingStates(frames)).toBe(0)
  })

  it('commits one loading state on a cold `/?session=`', async () => {
    render(<Surface selectedId="s1" sessionCount={3} />)
    await advance(SLOW_MS + SPINNER_THRESHOLD_MS)

    expect(loadingStates(frames)).toBe(1)
    expect(spinnerAfterContent(frames)).toBe(false)
    expect(frames.at(-1)).toMatchObject({ content: true, spinner: false })
  })

  it('commits one loading state for a 200-row transcript', async () => {
    getSession.mockImplementation((id: string) => new Promise((resolve) => {
      setTimeout(() => resolve({ id, status: 'idle', messages: transcript(id, 220) }), latencyMs)
    }))
    render(<Surface selectedId="long" sessionCount={3} />)
    await advance(SLOW_MS + SPINNER_THRESHOLD_MS)

    expect(loadingStates(frames)).toBe(1)
    expect(spinnerAfterContent(frames)).toBe(false)
  })

  it('commits one loading state for an empty chat and lands on the empty state, not the spinner', async () => {
    getSession.mockImplementation((id: string) => new Promise((resolve) => {
      setTimeout(() => resolve({ id, status: 'idle', messages: [] }), latencyMs)
    }))
    render(<Surface selectedId="empty" sessionCount={3} />)
    await advance(SLOW_MS + SPINNER_THRESHOLD_MS)

    expect(loadingStates(frames)).toBe(1)
    expect(frames.at(-1)).toMatchObject({ content: false, spinner: false })
  })
})

describe('moving between chats', () => {
  it('holds the outgoing transcript instead of blanking it to a spinner', async () => {
    latencyMs = FAST_MS
    const { rerender } = render(<Surface selectedId="a" sessionCount={3} />)
    await advance(FAST_MS)
    expect(frames.at(-1)).toMatchObject({ sessionId: 'a', content: true })
    const openFrames = frames.length

    rerender(<Surface selectedId="b" sessionCount={3} />)
    await advance(SWITCH_HOLD_MS + SPINNER_THRESHOLD_MS)

    const switchFrames = frames.slice(openFrames)
    // This is the regression: pre-fix the destination mounted cold, so the run
    // contained a content-free frame and then a spinner over it.
    expect(switchFrames.every((frame) => frame.content)).toBe(true)
    expect(loadingStates(switchFrames)).toBe(0)
    expect(spinnerAfterContent(frames)).toBe(false)
    expect(frames.at(-1)).toMatchObject({ sessionId: 'b', content: true, spinner: false })
  })

  it('returns to a chat it already showed without a second loading state', async () => {
    latencyMs = FAST_MS
    const { rerender } = render(<Surface selectedId="a" sessionCount={3} />)
    await advance(FAST_MS)
    rerender(<Surface selectedId="b" sessionCount={3} />)
    await advance(SWITCH_HOLD_MS)
    const beforeBack = frames.length

    // Browser back to the chat that is still in the snapshot cache.
    rerender(<Surface selectedId="a" sessionCount={3} />)
    await advance(SPINNER_THRESHOLD_MS)

    const backFrames = frames.slice(beforeBack)
    expect(backFrames.every((frame) => frame.content)).toBe(true)
    expect(loadingStates(backFrames)).toBe(0)
    expect(frames.at(-1)).toMatchObject({ sessionId: 'a', content: true, spinner: false })
  })

  it('commits the destination anyway once the hold budget runs out', async () => {
    latencyMs = FAST_MS
    const { rerender } = render(<Surface selectedId="a" sessionCount={3} />)
    await advance(FAST_MS)

    // A destination that never arrives must not strand the reader on the chat
    // they navigated away from.
    getSession.mockImplementation(() => new Promise(() => {}))
    rerender(<Surface selectedId="b" sessionCount={3} />)
    await advance(SWITCH_HOLD_MS)

    expect(frames.at(-1)?.sessionId).toBe('b')
  })
})

describe('a tab coming back', () => {
  it('does not re-announce a transcript it is already showing', async () => {
    latencyMs = FAST_MS
    const { rerender } = render(<Surface selectedId="a" sessionCount={3} />)
    await advance(FAST_MS)
    const beforeRestore = frames.length

    // Same selection, re-rendered the way a restored tab re-renders the route.
    rerender(<Surface selectedId="a" sessionCount={3} />)
    await advance(SPINNER_THRESHOLD_MS)

    const restored = frames.slice(beforeRestore)
    expect(restored.every((frame) => frame.content)).toBe(true)
    expect(loadingStates(restored)).toBe(0)
  })
})

describe('isOpenSelectionInbound', () => {
  const base = { selectedId: null, newChatIntent: false, sessionsPending: false, sessionCount: 0 }

  it('waits while the session list is still loading', () => {
    expect(isOpenSelectionInbound({ ...base, sessionsPending: true })).toBe(true)
  })

  it('waits while sessions exist but the auto-select URL has not landed', () => {
    expect(isOpenSelectionInbound({ ...base, sessionCount: 2 })).toBe(true)
  })

  it('does not wait when the reader asked for a blank composer', () => {
    expect(isOpenSelectionInbound({ ...base, sessionCount: 2, newChatIntent: true })).toBe(false)
  })

  it('does not wait once a session is selected', () => {
    expect(isOpenSelectionInbound({ ...base, selectedId: 's1', sessionsPending: true })).toBe(false)
  })

  it('does not wait when the list resolved with nothing in it', () => {
    expect(isOpenSelectionInbound(base)).toBe(false)
  })
})
