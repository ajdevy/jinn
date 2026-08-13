import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import type { Message } from '@/lib/conversations'
import { ChatMessages } from '../chat-messages'
import { installVirtualLayout } from './virtual-layout'

/**
 * Prepend anchoring on a real older-message page, once the transcript is windowed.
 *
 * The thread is long enough to virtualise, so the row the read position is
 * measured against is the NORMAL case for a full page: a hundred rows above the
 * window, unmounted, with no rect left to measure. Holding the reader still
 * there is what this file is about — `virtual-layout.ts` supplies the jsdom
 * layout the virtualizer needs, and offsets are read back off the mounted DOM.
 *
 * Every message is a user message on purpose: user rows never fold and never
 * group, so one message is one virtual row.
 */

const ROW_H = 100
const VIEWPORT_H = 700
const OLDER_PAGE = 100

function transcript(from: number, count: number): Message[] {
  return Array.from({ length: count }, (_, k) => ({
    id: `m${from + k}`,
    role: 'user' as const,
    content: `message ${from + k}`,
    timestamp: 1_700_000_000_000 + (from + k) * 60_000,
  }))
}

/** A promise the test resolves by hand, so the page can land mid-flight. */
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

afterEach(() => { vi.restoreAllMocks() })

describe('ChatMessages older-page anchoring', () => {
  const initial = transcript(100, 150)
  const older = transcript(0, OLDER_PAGE)

  const view = (list: Message[], hasOlder: boolean, load: () => Promise<void>) => (
    <ChatMessages
      messages={list}
      loading={false}
      hasOlderMessages={hasOlder}
      onLoadOlderMessages={load}
    />
  )

  it('mounts a window, not the whole thread', () => {
    const vp = installVirtualLayout(ROW_H, VIEWPORT_H)
    render(view(initial, true, () => Promise.resolve()))
    act(() => { vp.scrollTo(4_000) })

    const mounted = vp.mountedMessageIds()
    expect(mounted.length).toBeGreaterThan(0)
    expect(mounted.length).toBeLessThan(initial.length / 2)
    vp.release()
  })

  it('holds the read position when a full older page is prepended', () => {
    let messages = initial
    const page = deferred()
    const vp = installVirtualLayout(ROW_H, VIEWPORT_H)
    const { rerender } = render(view(initial, true, () => page.promise))

    // Read up until the older-page load fires (scrollTop <= OLDER_LOAD_THRESHOLD_PX).
    act(() => { vp.scrollTo(500) })
    const anchorId = vp.visibleMessageIds()[1]
    const before = vp.offsetOf(anchorId)

    // The page lands. The anchored row is now 100 rows above the window.
    messages = [...older, ...initial]
    act(() => {
      page.resolve()
      rerender(view(messages, false, () => page.promise))
    })

    expect(vp.mountedMessageIds()).toContain(anchorId)
    expect(Math.abs(vp.offsetOf(anchorId) - before)).toBeLessThanOrEqual(4)
    vp.release()
  })

  it('still holds it when a new message is appended while the page is in flight', () => {
    // The regression: any `messages` change used to consume the pending anchor,
    // so an assistant reply arriving mid-flight spent the correction on a commit
    // that moved nothing, and the real prepend landed uncorrected.
    const appended: Message[] = [{ id: 'm250', role: 'user', content: 'live', timestamp: 1_800_000_000_000 }]
    let messages = initial
    const page = deferred()
    const vp = installVirtualLayout(ROW_H, VIEWPORT_H)
    const { rerender } = render(view(initial, true, () => page.promise))

    act(() => { vp.scrollTo(500) })
    const anchorId = vp.visibleMessageIds()[1]
    const before = vp.offsetOf(anchorId)

    // A message arrives below the read position while the request is still open.
    messages = [...initial, ...appended]
    act(() => { rerender(view(messages, true, () => page.promise)) })
    expect(vp.offsetOf(anchorId)).toBe(before)

    // Now the older page lands.
    messages = [...older, ...initial, ...appended]
    act(() => {
      page.resolve()
      rerender(view(messages, false, () => page.promise))
    })

    expect(Math.abs(vp.offsetOf(anchorId) - before)).toBeLessThanOrEqual(4)
    vp.release()
  })
})
