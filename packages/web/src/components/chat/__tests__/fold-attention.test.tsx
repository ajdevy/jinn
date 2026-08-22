import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FoldRegion } from '../fold-region'
import { FOLD_LANDING_PAD_MS, FOLD_MS } from '../fold-motion'

/**
 * A region files itself away only when nobody is on it.
 *
 * Scrolling clear of the top of the viewport is the usual proof of that, but it
 * is not the only one: the pointer can rest on a region the transcript has
 * since scrolled past, and focus can be inside it. Either one means the reader
 * is still using it, and the next ask is not a reason to close it under them.
 * But a decline is "not now", not "never": the ask stands, and the region
 * answers it as soon as the reader's attention moves on.
 */

const SUMMARY = { durationMs: 5_000, tools: 1, teammates: 0, updates: 0 }
const SETTLE_MS = FOLD_MS + FOLD_LANDING_PAD_MS + 20

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height, left: 0, right: 500, width: 500, x: 0, y: top, toJSON: () => ({}) } as DOMRect
}

describe('auto-collapse declines while the reader is on the region', () => {
  let frames: FrameRequestCallback[]

  beforeEach(() => {
    vi.useFakeTimers()
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    // Scrolled clear of the top edge — the one place a fold may collapse itself.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('chat-messages-scroll')) return rect(64, 800)
      if (this.hasAttribute('data-fold')) return rect(-420, 300)
      return rect(0, 0)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const mount = () => {
    const tree = (collapseRequested: boolean) => (
      <div className="chat-messages-scroll">
        <FoldRegion answered liveCompletion collapseRequested={collapseRequested} summary={SUMMARY}>
          <button type="button">evidence</button>
        </FoldRegion>
      </div>
    )
    const view = render(tree(false))
    return {
      wrap: () => view.container.querySelector<HTMLElement>('[data-fold]')!,
      control: () => screen.getByRole('button', { name: /the work/ }),
      /** A later ask nominates the region for collapse; run it out to rest. */
      nextAsk: () => {
        view.rerender(tree(true))
        for (let pass = 0; pass < 10 && frames.length > 0; pass++) {
          const batch = frames.splice(0, frames.length)
          act(() => { for (const cb of batch) cb(0) })
        }
        act(() => { vi.advanceTimersByTime(SETTLE_MS) })
      },
    }
  }

  it('files it away when nobody is on it', () => {
    const fold = mount()

    fold.nextAsk()

    expect(fold.control().getAttribute('aria-expanded')).toBe('false')
    expect(fold.wrap().hasAttribute('data-folded')).toBe(true)
  })

  it('leaves it open while the pointer is over it', () => {
    const fold = mount()
    fireEvent.mouseOver(fold.wrap())

    fold.nextAsk()

    expect(fold.control().getAttribute('aria-expanded')).toBe('true')
    expect(fold.wrap().hasAttribute('data-folded')).toBe(false)
  })

  it('leaves it open while focus is inside it', () => {
    const fold = mount()
    act(() => { screen.getByRole('button', { name: 'evidence' }).focus() })

    fold.nextAsk()

    expect(fold.control().getAttribute('aria-expanded')).toBe('true')
    expect(fold.wrap().hasAttribute('data-folded')).toBe(false)
  })

  it('files it away again once the pointer has left', () => {
    const fold = mount()
    fireEvent.mouseOver(fold.wrap())
    fireEvent.mouseOut(fold.wrap())

    fold.nextAsk()

    expect(fold.control().getAttribute('aria-expanded')).toBe('false')
  })

  it('honours the standing ask once the pointer leaves afterwards', () => {
    // The ask arrives while the reader is on the region, so it is declined —
    // and there is no second edge coming. Leaving has to be the edge, or the
    // region never files itself away for the rest of the session.
    const fold = mount()
    fireEvent.mouseOver(fold.wrap())
    fold.nextAsk()
    expect(fold.control().getAttribute('aria-expanded')).toBe('true')

    fireEvent.mouseOut(fold.wrap())

    expect(fold.control().getAttribute('aria-expanded')).toBe('false')
    expect(fold.wrap().hasAttribute('data-folded')).toBe(true)
  })

  it('honours the standing ask once focus leaves afterwards', () => {
    const fold = mount()
    const inside = screen.getByRole('button', { name: 'evidence' })
    act(() => { inside.focus() })
    fold.nextAsk()
    expect(fold.control().getAttribute('aria-expanded')).toBe('true')

    act(() => { inside.blur() })
    fireEvent.blur(inside, { relatedTarget: null })

    expect(fold.control().getAttribute('aria-expanded')).toBe('false')
  })
})
