import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, type RenderHookResult } from '@testing-library/react'
import { scrollTranscriptTo, useTranscriptVirtualizer, type TranscriptVirtualizer } from '../transcript-virtualizer'
import { fakeScroller, SCROLLER_HEIGHT } from './fake-scroller'
import type { RenderGroup } from '../chat-messages'

/**
 * The flick keeps gliding after the finger leaves.
 *
 * WebKit owns the momentum, and assigning `scrollTop` ends it where it stands —
 * which is what the reader described as the list going sticky to their finger.
 * The transcript makes exactly one write nobody asked for: the correction the
 * virtualizer issues when a row above the reader re-measures. That one waits for
 * the glide. Everything the reader asks for still goes through at once.
 */

const COUNT = 60
/** What `estimateGroupSize` gives a plain message; the correction is in the gap. */
const ESTIMATED_ROW = 140
const MEASURED_ROW = 340
const CORRECTION = MEASURED_ROW - ESTIMATED_ROW
/** Comfortably past the settle window, so a held write has no excuse left. */
const AFTER_THE_GLIDE = 1000

function fakeGroups(): RenderGroup[] {
  return Array.from({ length: COUNT }, () => ({ kind: 'plain', item: { kind: 'message' } })) as RenderGroup[]
}

function mountTranscript() {
  const { el, scrollTo } = fakeScroller(() => COUNT * ESTIMATED_ROW)
  const groups = fakeGroups()
  const keys = groups.map((_, index) => `g${index}`)
  const view = renderHook(() => useTranscriptVirtualizer(groups, keys, true, () => el as HTMLDivElement, 0))
  // Measuring the rows is what gives the virtualizer something to correct.
  act(() => { view.result.current.getTotalSize() })
  return { el, scrollTo, view }
}

/**
 * The first row turns out taller than its estimate while the reader sits far
 * below it — the one case the virtualizer answers by moving the scroller.
 */
function remeasureAboveTheReader(view: RenderHookResult<TranscriptVirtualizer, unknown>): void {
  act(() => {
    view.result.current.scrollOffset = 5000
    view.result.current.resizeItem(0, MEASURED_ROW)
  })
}

describe('a re-measure correction waits for the reader\'s flick to finish', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('ResizeObserver', class {
      constructor(_cb: ResizeObserverCallback) {}
      observe() {}
      unobserve() {}
      disconnect() {}
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })

  it('holds the correction while a finger is down, and issues it once the glide settles', () => {
    const { el, scrollTo, view } = mountTranscript()

    el.dispatchEvent(new Event('touchstart'))
    remeasureAboveTheReader(view)

    expect(scrollTo).not.toHaveBeenCalled()

    el.dispatchEvent(new Event('touchend'))
    act(() => { vi.advanceTimersByTime(AFTER_THE_GLIDE) })

    // Applied where the reader ended up, not at the offset it was computed for:
    // the content it compensates for moved above them wherever they came to rest.
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ top: CORRECTION })
  })

  it('goes on holding after the lift for as long as the momentum keeps reporting', () => {
    const { el, scrollTo, view } = mountTranscript()

    el.dispatchEvent(new Event('touchstart'))
    el.dispatchEvent(new Event('touchend'))
    remeasureAboveTheReader(view)

    // The finger is gone but the list is still gliding, and this is the stretch
    // the reader actually watches — a write landing here is the stick they saw.
    for (let tick = 0; tick < 5; tick += 1) {
      act(() => { vi.advanceTimersByTime(80) })
      el.dispatchEvent(new Event('scroll'))
    }
    expect(scrollTo).not.toHaveBeenCalled()

    act(() => { vi.advanceTimersByTime(AFTER_THE_GLIDE) })
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  it('lets a deliberate jump to the end through mid-flick — the reader asked for that one', () => {
    const { el, scrollTo, view } = mountTranscript()

    el.dispatchEvent(new Event('touchstart'))
    act(() => {
      scrollTranscriptTo(view.result.current, (v) => v.scrollToIndex(COUNT - 1, { align: 'end' }))
    })

    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ top: COUNT * ESTIMATED_ROW - SCROLLER_HEIGHT }),
    )
  })
})
