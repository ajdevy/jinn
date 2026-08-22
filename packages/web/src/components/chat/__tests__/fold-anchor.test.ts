import { describe, expect, it } from 'vitest'
import { anchorScrollDuring, canAnchorFold, foldIsAboveViewport } from '../fold-anchor'

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

  it('yields even when the flick lands before the loop has written anything', () => {
    // The gap between scheduling the loop and its first frame is a whole frame
    // long, and a flick fits in it. Taking the scheduling position as the last
    // written one is what makes that first frame able to tell.
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

    scroller.scrollTop = 860
    now = 16
    frames.shift()!(now)

    expect(top).toBe(860)
    expect(frames).toHaveLength(0)
  })

  it('stops on the first frame of a finger drag and never writes again', () => {
    // The sticky-swipe symptom: the reader drags while a fold is compensating.
    // A drag moves the scroller EVERY frame, so the loop has to give up on the
    // first one it sees rather than fighting a moving target frame after frame.
    let top = 1000
    let bottom = 500
    const writes: number[] = []
    const scroller = {
      get scrollTop() { return top },
      set scrollTop(next: number) { writes.push(next); bottom -= next - top; top = next },
    } as unknown as Element
    // The fold is still shrinking, so every frame there is a delta to chase.
    const anchor = { getBoundingClientRect: () => ({ bottom: bottom -= 6 }) } as unknown as Element
    const frames: FrameRequestCallback[] = []
    let now = 0
    anchorScrollDuring(scroller, anchor, 480, { raf: (cb) => { frames.push(cb); return 1 }, now: () => now })

    // Frame 1: nobody else has touched the scroller, so it compensates.
    now = 16
    frames.shift()!(now)
    expect(writes).toHaveLength(1)

    // The finger takes over, moving the scroller a little every frame.
    for (const step of [40, 80, 120]) {
      top -= step
      now += 16
      frames.shift()?.(now)
    }

    expect(writes).toHaveLength(1)
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

describe('off-screen gate', () => {
  // The scroller's viewport, with the transcript header above it.
  const viewport = { top: 64, bottom: 864 }

  it.each([
    ['scrolled clear of the top edge', { top: -420, bottom: -60 }, true],
    ['bottom edge one pixel above the viewport', { top: -300, bottom: 63 }, true],
    ['bottom edge flush with the viewport top', { top: -300, bottom: 64 }, false],
    ['a sliver still showing', { top: -300, bottom: 71 }, false],
    ['fully on screen', { top: 120, bottom: 480 }, false],
    ['still below the fold', { top: 900, bottom: 1200 }, false],
  ])('%s → %s', (_case, fold, expected) => {
    expect(foldIsAboveViewport(fold, viewport)).toBe(expected)
  })

  it('answers no when there is no geometry to answer with', () => {
    // A display:none transcript reads all zeros on both sides. An unproven
    // collapse is the one that moves a pixel the reader was looking at.
    expect(foldIsAboveViewport({ top: 0, bottom: 0 }, { top: 0, bottom: 0 })).toBe(false)
  })
})
