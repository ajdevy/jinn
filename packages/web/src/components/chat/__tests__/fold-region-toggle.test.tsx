import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FoldRegion } from '../fold-region'
import { FOLD_LANDING_PAD_MS, FOLD_MS } from '../fold-motion'

/**
 * One click, one outcome.
 *
 * The fold animates through a frame and lands on a timer, so a click can arrive
 * while a previous one is still in flight — before its frame has run, or after
 * the frame but before the timer. Every one of those starts has to answer the
 * click the reader just made and nothing else: the loser's timer must not land
 * after the winner's and rest the region in a state nobody asked for.
 */

const SUMMARY = { durationMs: 5_000, tools: 1, teammates: 0, updates: 0 }
/** Past the landing timer (FOLD_MS + FOLD_LANDING_PAD_MS). */
const SETTLE_MS = FOLD_MS + FOLD_LANDING_PAD_MS + 20

/** Frames a test runs by hand, so a click can land before one of them does. */
function stubFrames() {
  const frames = new Map<number, FrameRequestCallback>()
  let nextId = 1
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextId++
    frames.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  return {
    /** Run every queued frame, and anything they queue in turn. */
    flush: () => {
      for (let pass = 0; pass < 10 && frames.size > 0; pass++) {
        const batch = [...frames.values()]
        frames.clear()
        act(() => { for (const cb of batch) cb(0) })
      }
    },
  }
}

function asRect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height, left: 0, right: 500, width: 500, x: 0, y: top, toJSON: () => ({}) } as DOMRect
}

function mountFold() {
  const view = render(
    <div className="chat-messages-scroll">
      <FoldRegion answered summary={SUMMARY}>
        <div>evidence</div>
      </FoldRegion>
    </div>,
  )
  return {
    region: () => view.container.querySelector<HTMLElement>('[data-fold-region]')!,
    control: () => screen.getByRole('button'),
    click: () => fireEvent.click(screen.getByRole('button')),
  }
}

type Fold = ReturnType<typeof mountFold>

describe('fold region toggle', () => {
  let frames: ReturnType<typeof stubFrames>

  beforeEach(() => {
    vi.useFakeTimers()
    frames = stubFrames()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** Run the animation the click started all the way to its resting state. */
  const settle = () => {
    frames.flush()
    act(() => { vi.advanceTimersByTime(SETTLE_MS) })
    frames.flush()
  }

  const openIt = (fold: Fold) => { fold.click(); settle() }

  const starts = [
    { start: 'rest-closed', arrive: () => {}, expected: 'open' },
    { start: 'rest-open', arrive: (fold: Fold) => openIt(fold), expected: 'closed' },
    // Mid-animation: the frame has run, the landing timer has not.
    { start: 'mid-collapse', arrive: (fold: Fold) => { openIt(fold); fold.click(); frames.flush() }, expected: 'open' },
    { start: 'mid-expand', arrive: (fold: Fold) => { fold.click(); frames.flush() }, expected: 'closed' },
    // Interrupted before the animation's own frame has even run — the case
    // where the abandoned run's timer used to land last and win.
    { start: 'collapse not yet framed', arrive: (fold: Fold) => { openIt(fold); fold.click() }, expected: 'open' },
    { start: 'expand not yet framed', arrive: (fold: Fold) => { fold.click() }, expected: 'closed' },
  ]

  it('a region that filed itself away opens again on one click', () => {
    // The automatic fold is instant and happens off-screen, so by the time the
    // reader scrolls back to it, it is already closed. One click has to reopen
    // it, the same as any other closed region.
    const scroller = { top: 64, bottom: 864 }
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('chat-messages-scroll')) return asRect(scroller.top, 800)
      // Scrolled clear of the top edge, which is the only place a fold may
      // collapse itself.
      if (this.hasAttribute('data-fold')) return asRect(-420, 300)
      return asRect(0, 0)
    })
    const view = render(
      <div className="chat-messages-scroll">
        <FoldRegion answered liveCompletion summary={SUMMARY}><div>evidence</div></FoldRegion>
      </div>,
    )
    const fold = {
      region: () => view.container.querySelector<HTMLElement>('[data-fold-region]')!,
      control: () => screen.getByRole('button'),
      click: () => fireEvent.click(screen.getByRole('button')),
    }
    view.rerender(
      <div className="chat-messages-scroll">
        <FoldRegion answered liveCompletion collapseRequested summary={SUMMARY}><div>evidence</div></FoldRegion>
      </div>,
    )
    frames.flush()

    fold.click()
    settle()

    expect(fold.control().getAttribute('aria-expanded')).toBe('true')
    expect(fold.region().getAttribute('aria-hidden')).toBeNull()
    expect(fold.region().style.height).toBe('auto')
  })

  it.each(starts)('from $start, one click rests it $expected', ({ arrive, expected }) => {
    const fold = mountFold()
    arrive(fold)

    fold.click()
    settle()

    const region = fold.region()
    if (expected === 'open') {
      expect(fold.control().getAttribute('aria-expanded')).toBe('true')
      expect(region.getAttribute('aria-hidden')).toBeNull()
      // `auto`, never a pixel height: a clamped one freezes the region at
      // whatever the content measured the moment it opened.
      expect(region.style.height).toBe('auto')
    } else {
      expect(fold.control().getAttribute('aria-expanded')).toBe('false')
      expect(region.getAttribute('aria-hidden')).toBe('true')
      expect(region.style.height).toBe('0px')
    }
  })
})
