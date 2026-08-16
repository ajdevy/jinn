/**
 * Chat open continuity — the six open scenarios, measured rather than eyeballed.
 *
 * Every commit of the pane is recorded as a frame, so "one loading state" and
 * "never a spinner after content" are counted off the sequence instead of being
 * asserted from an impression. A loading state means a visible loading
 * affordance: the route-level fallback a cold open waits at, and the hydration
 * spinner the pane shows afterwards — one run across both, because that is one
 * wait as far as the reader is concerned. The beat where the opening selection
 * is still resolving paints nothing at all, and is recorded as the absence of a
 * pane rather than as a loading state — which is exactly what it looks like.
 *
 * `open-continuity-harness` is the surface under all of it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'

const getSession = vi.fn()
vi.mock('@/lib/api', () => ({
  api: { getSession: (id: string, options?: unknown) => getSession(id, options) },
}))

import { isOpenSelectionInbound } from '../selection-commit'
import { __resetRouteLoadingHandoffForTests } from '@/components/chat/chat-hydration'
import { __clearLiveSessionSnapshotCacheForTests } from '@/hooks/use-live-session'
import {
  advance,
  ColdDirectOpen,
  FAST_MS,
  frames,
  loadingStates,
  PAST_ANY_THRESHOLD_MS,
  resetFrames,
  SLOW_MS,
  SPINNER_THRESHOLD_MS,
  spinnerAfterContent,
  Surface,
  transcript,
} from './open-continuity-harness'

let latencyMs = SLOW_MS

beforeEach(() => {
  vi.useFakeTimers()
  resetFrames()
  latencyMs = SLOW_MS
  getSession.mockReset()
  getSession.mockImplementation((id: string) => new Promise((resolve) => {
    setTimeout(() => resolve({ id, status: 'idle', messages: transcript(id, 4) }), latencyMs)
  }))
  __clearLiveSessionSnapshotCacheForTests()
  __resetRouteLoadingHandoffForTests()
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

  it('carries the route fallback straight into the pane on a stalled cold `/?session=`', async () => {
    // The gateway never answers, so the whole open is one uninterrupted wait —
    // the case where a second announcement is unmistakable. Pre-fix the pane
    // paid the 250ms threshold again and the run read: spinner, nothing, spinner.
    getSession.mockImplementation(() => new Promise(() => {}))
    const { rerender } = render(<ColdDirectOpen selectedId="cold" chunkLoaded={false} />)
    await advance(SLOW_MS)

    rerender(<ColdDirectOpen selectedId="cold" chunkLoaded />)
    await advance(PAST_ANY_THRESHOLD_MS)

    expect(frames.every((frame) => frame.spinner)).toBe(true)
    expect(loadingStates(frames)).toBe(1)
  })

  it('still withholds the spinner when the chunk was already cached and the transcript is quick', async () => {
    latencyMs = FAST_MS
    render(<Surface selectedId="warm" sessionCount={3} />)
    await advance(FAST_MS + SPINNER_THRESHOLD_MS)

    expect(loadingStates(frames)).toBe(0)
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
    await advance(FAST_MS + SPINNER_THRESHOLD_MS)

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
    await advance(FAST_MS)
    const beforeBack = frames.length

    // Browser back to the chat that is still in the snapshot cache.
    rerender(<Surface selectedId="a" sessionCount={3} />)
    await advance(SPINNER_THRESHOLD_MS)

    const backFrames = frames.slice(beforeBack)
    expect(backFrames.every((frame) => frame.content)).toBe(true)
    expect(loadingStates(backFrames)).toBe(0)
    expect(frames.at(-1)).toMatchObject({ sessionId: 'a', content: true, spinner: false })
  })

  it('keeps holding a destination that stalls rather than commit it to a spinner', async () => {
    latencyMs = FAST_MS
    const { rerender } = render(<Surface selectedId="a" sessionCount={3} />)
    await advance(FAST_MS)

    // Pre-fix a 250ms deadline committed the destination mid-fetch, and its own
    // hydration threshold then put a spinner over the transcript the reader had
    // been reading for half a second.
    getSession.mockImplementation(() => new Promise(() => {}))
    rerender(<Surface selectedId="stalled" sessionCount={3} />)
    await advance(PAST_ANY_THRESHOLD_MS)

    expect(spinnerAfterContent(frames)).toBe(false)
    expect(frames.at(-1)).toMatchObject({ sessionId: 'a', content: true, spinner: false })
  })

  it('commits the destination as soon as its fetch fails, so the reader is never stranded', async () => {
    latencyMs = FAST_MS
    const { rerender } = render(<Surface selectedId="a" sessionCount={3} />)
    await advance(FAST_MS)

    getSession.mockImplementation(() => Promise.reject(new Error('gateway unreachable')))
    rerender(<Surface selectedId="broken" sessionCount={3} />)
    await advance(SPINNER_THRESHOLD_MS)

    expect(frames.at(-1)?.sessionId).toBe('broken')
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
