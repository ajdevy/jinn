import { describe, expect, it } from 'vitest'
import { anchorScrollDuring, canAnchorFold } from '../fold-anchor'

/**
 * The fold's scroll compensation, as arithmetic. Both pieces are pure enough to
 * drive from a fake scroller, which is the only way to see per-frame behaviour
 * at all — jsdom reports every rect as zero, so the loop never writes there.
 */

describe('anchorScrollDuring', () => {
  it('anchorScrollDuring compensates scrollTop by the anchor bottom delta each frame', () => {
    const scroller = { scrollTop: 100 } as unknown as Element
    let bottom = 500
    const anchor = { getBoundingClientRect: () => ({ bottom }) } as unknown as Element
    const frames: FrameRequestCallback[] = []
    let now = 0
    anchorScrollDuring(scroller, anchor, 100, { raf: (cb) => { frames.push(cb); return 1 }, now: () => now })

    bottom = 480
    now = 16
    frames.shift()!(now)
    expect(scroller.scrollTop).toBe(80)

    bottom = 470
    now = 200
    frames.shift()!(now)
    expect(scroller.scrollTop).toBe(50)
    // Past the window: no further frames scheduled.
    expect(frames).toHaveLength(0)
  })

  it('anchorScrollDuring yields the scroller to a user scroll instead of overwriting it', () => {
    // A scroller that moves its content the way a real one does: scrolling down
    // by n lifts everything, the anchor's client rect included, by n. Without
    // that coupling a compensating write would never settle.
    let top = 1000
    let bottom = 500
    const scroller = {
      get scrollTop() { return top },
      set scrollTop(next: number) { bottom -= next - top; top = next },
    } as unknown as Element
    const anchor = { getBoundingClientRect: () => ({ bottom }) } as unknown as Element
    const frames: FrameRequestCallback[] = []
    let now = 0
    anchorScrollDuring(scroller, anchor, 480, { raf: (cb) => { frames.push(cb); return 1 }, now: () => now })

    // Frame 1: the fold's own shrink lifts the anchor, and the loop puts it back.
    bottom -= 20
    now = 16
    frames.shift()!(now)
    expect(top).toBe(980)
    expect(bottom).toBe(500)

    // The reader flicks up mid-window.
    scroller.scrollTop = 860
    now = 32
    frames.shift()!(now)

    // Their position stands, and the loop has stopped scheduling.
    expect(top).toBe(860)
    expect(frames).toHaveLength(0)
  })
})

describe('fold slack gate', () => {
  it('only anchors the live fold when scrollTop can absorb the shrink', () => {
    // QA-measured clamp case: slack 27, region ~331 (delta 299) → skip.
    expect(canAnchorFold(27, 331)).toBe(false)
    // Enough slack: 400 ≥ 331 - 32.
    expect(canAnchorFold(400, 331)).toBe(true)
    // Boundary: slack + 2 tolerance against delta.
    expect(canAnchorFold(297, 331)).toBe(true)
    expect(canAnchorFold(296, 331)).toBe(false)
    // A tiny region folds even at scrollTop 0 (delta ≤ summary height).
    expect(canAnchorFold(0, 32)).toBe(true)
  })
})
