/**
 * Opening a chat on a phone, measured the same way the desktop opens are.
 *
 * The phone has one screen, not two columns: the chat list and the thread share
 * a slot, and tapping a row reveals it in the same paint. The pane inside that
 * slot is a step behind the URL by design — a switch holds the outgoing
 * transcript rather than blanking it — so on a phone the hold has nothing to
 * preserve and everything to expose: the transcript it holds up is the chat the
 * reader left, and the slot puts it back in front of them.
 *
 * Frames are only recorded while the slot is on screen, because a frame the
 * reader cannot see is not a flash. `PhoneSurface` in the open-continuity
 * harness is the surface under all of it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const getSession = vi.fn()
vi.mock('@/lib/api', () => ({
  api: { getSession: (id: string, options?: unknown) => getSession(id, options) },
}))

import { __resetRouteLoadingHandoffForTests } from '@/components/chat/chat-hydration'
import { __clearLiveSessionSnapshotCacheForTests } from '@/hooks/use-live-session'
import {
  advance,
  FAST_MS,
  frames,
  loadingStates,
  PhoneSurface,
  resetFrames,
  SLOW_MS,
  SPINNER_THRESHOLD_MS,
  spinnerAfterContent,
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

/** Read a chat, then take the back chip to the list. The pane stays mounted on
 *  that chat behind the hidden slot, which is the state every case here opens
 *  from — and the reason the reveal has something stale to paint. */
async function readThenBackToList(sessionId: string, rows: string[]) {
  render(<PhoneSurface initialSelectedId={sessionId} rows={rows} />)
  await advance(latencyMs)
  expect(frames.at(-1)).toMatchObject({ sessionId, content: true })
  fireEvent.click(screen.getByTestId('back'))
  await advance(0)
}

describe('opening a chat from the list on a phone', () => {
  it('never paints the chat the reader left, at any point in the open', async () => {
    await readThenBackToList('a', ['b'])
    // Measured from the tap: everything before it was a different screen.
    resetFrames()

    fireEvent.click(screen.getByTestId('row-b'))
    await advance(SLOW_MS + SPINNER_THRESHOLD_MS)

    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every((frame) => frame.sessionId === 'b')).toBe(true)
    expect(frames.at(-1)).toMatchObject({ sessionId: 'b', content: true, spinner: false })
  })

  it('shows the destination its own wait and nothing else', async () => {
    await readThenBackToList('a', ['b'])
    resetFrames()

    fireEvent.click(screen.getByTestId('row-b'))
    await advance(SLOW_MS + SPINNER_THRESHOLD_MS)

    expect(loadingStates(frames)).toBeLessThanOrEqual(1)
    expect(spinnerAfterContent(frames)).toBe(false)
  })

  it('opens a chat it has already read without a loading state at all', async () => {
    latencyMs = FAST_MS
    await readThenBackToList('a', ['a'])
    resetFrames()

    // Same chat, straight back into it: the snapshot is warm, so the destination
    // paints on its first commit and the reader waits for nothing.
    fireEvent.click(screen.getByTestId('row-a'))
    await advance(FAST_MS + SPINNER_THRESHOLD_MS)

    expect(frames.every((frame) => frame.sessionId === 'a' && frame.content)).toBe(true)
    expect(loadingStates(frames)).toBe(0)
  })

  it('is clean again after browser back has taken the reader out to the list', async () => {
    await readThenBackToList('b', ['c'])
    fireEvent.click(screen.getByTestId('pop-to-list'))
    await advance(SPINNER_THRESHOLD_MS)
    resetFrames()

    fireEvent.click(screen.getByTestId('row-c'))
    await advance(SLOW_MS + SPINNER_THRESHOLD_MS)

    // Neither the chat that was open nor the composer the bare `/` committed
    // behind the list: the reveal only ever paints what was tapped.
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every((frame) => frame.sessionId === 'c')).toBe(true)
    expect(frames.at(-1)).toMatchObject({ sessionId: 'c', content: true, spinner: false })
  })
})

describe('opening a chat from inside another chat on a phone', () => {
  it('still holds the transcript the reader is looking at', async () => {
    latencyMs = FAST_MS
    // A thread drill-in: the slot is already on screen, so there IS an outgoing
    // transcript, and holding it is what keeps the switch from blanking.
    render(<PhoneSurface initialSelectedId="a" rows={['b']} />)
    await advance(FAST_MS)
    const beforeSwitch = frames.length

    fireEvent.click(screen.getByTestId('row-b'))
    await advance(FAST_MS + SPINNER_THRESHOLD_MS)

    const switchFrames = frames.slice(beforeSwitch)
    expect(switchFrames.every((frame) => frame.content)).toBe(true)
    expect(loadingStates(switchFrames)).toBe(0)
    expect(frames.at(-1)).toMatchObject({ sessionId: 'b', content: true, spinner: false })
  })
})
