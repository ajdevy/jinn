import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatMessages } from '../chat-messages'
import type { Message } from '@/lib/conversations'

vi.mock('@/lib/api', () => ({
  api: { getSession: vi.fn().mockResolvedValue({ messages: [] }) },
}))

/**
 * A send adds content below and moves nothing the reader can see.
 *
 * The next ask nominates every answered region for collapse, and a region
 * declines while any part of it is still on screen — for good, not for a while.
 * Only one already scrolled off the top files itself away, where the collapse
 * costs the reader no pixel at all.
 */

const T0 = 1_780_000_000_000

const ANSWERED: Message[] = [
  { id: 'u1', role: 'user', content: 'Go.', timestamp: T0 },
  { id: 't1', role: 'assistant', content: 'Used grep', timestamp: T0 + 1_000, toolCall: 'grep' },
  { id: 'a1', role: 'assistant', content: 'All done.', timestamp: T0 + 2_000 },
]

const NEXT_ASK: Message = { id: 'u2', role: 'user', content: 'One more.', timestamp: T0 + 3_000 }

const VIEWPORT_TOP = 64
const VIEWPORT_H = 800
const CONTENT_H = 5_000
/** The region's height with its evidence showing, and with it folded away. */
const OPEN_H = 300
const CLOSED_H = 56

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height, left: 0, right: 500, width: 500, x: 0, y: top, toJSON: () => ({}) } as DOMRect
}

/**
 * The one geometry these tests model: a scroller whose viewport sits below the
 * transcript header, and a fold at a fixed place in the content. Scrolling
 * moves the fold's rect the way a browser would, so compensation converges
 * instead of chasing a rect that never answers back.
 */
function placeFold(scroller: HTMLElement, contentTop: number, scrollTop: number) {
  const state = { top: scrollTop }
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => state.top,
    set: (next: number) => { state.top = Math.max(0, next) },
  })
  // A reader partway up a long transcript. jsdom reports zero for both, which
  // reads as pinned to the bottom, and the transcript would then scroll itself
  // on every send — a write that has nothing to do with the fold.
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => CONTENT_H })
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => VIEWPORT_H })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('chat-messages-scroll')) return rect(VIEWPORT_TOP, VIEWPORT_H)
    if (this.hasAttribute('data-fold')) {
      const height = this.hasAttribute('data-folded') ? CLOSED_H : OPEN_H
      return rect(VIEWPORT_TOP + contentTop - state.top, height)
    }
    return rect(0, 0)
  })
  return state
}

/** Run the fold's frames and its landing timer out to rest. */
function settle(frames: FrameRequestCallback[]) {
  for (let pass = 0; pass < 12 && frames.length > 0; pass++) {
    const batch = frames.splice(0, frames.length)
    act(() => { for (const cb of batch) cb(0) })
  }
  act(() => { vi.advanceTimersByTime(500) })
  const batch = frames.splice(0, frames.length)
  act(() => { for (const cb of batch) cb(0) })
}

describe('a send never moves what the reader can see', () => {
  let frames: FrameRequestCallback[]

  beforeEach(() => {
    vi.useFakeTimers()
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const mount = (contentTop: number, scrollTop: number) => {
    const view = render(<ChatMessages messages={ANSWERED} loading={false} liveFinalResponseId="a1" />)
    const scroller = view.container.querySelector<HTMLElement>('.chat-messages-scroll')!
    const state = placeFold(scroller, contentTop, 0)
    // The transcript opens pinned to the bottom; the reader then scrolls up to
    // where the test wants them, which is what disengages auto-follow.
    settle(frames)
    act(() => {
      state.top = scrollTop
      fireEvent.scroll(scroller)
    })
    settle(frames)
    return { view, scroller, state, fold: () => view.container.querySelector<HTMLElement>('[data-fold]')! }
  }

  const send = (view: ReturnType<typeof render>) => {
    view.rerender(<ChatMessages messages={[...ANSWERED, NEXT_ASK]} loading turnPending liveFinalResponseId="a1" />)
    settle(frames)
  }

  it('leaves a fold the reader can see open, and the scroller where it was', () => {
    // The fold sits 100px below the top of the viewport.
    const { view, state, fold } = mount(1_300, 1_200)
    const before = state.top
    expect(fold().hasAttribute('data-folded')).toBe(false)

    send(view)

    expect(fold().hasAttribute('data-folded')).toBe(false)
    expect(screen.getByRole('button', { name: /Hide the work/ })).toBeTruthy()
    expect(Math.abs(state.top - before)).toBeLessThanOrEqual(1)
  })

  it('drops its compensation when the reader moves the scroller first', () => {
    // The instant paths — reduced motion, a fold with no slack to animate into
    // — hold the content below still by writing scrollTop a frame later. If the
    // finger has moved in the meantime that write lands on top of a drag, which
    // is the swipe going sticky.
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
    const view = render(<ChatMessages messages={[...ANSWERED, NEXT_ASK]} loading={false} />)
    const scroller = view.container.querySelector<HTMLElement>('.chat-messages-scroll')!
    const state = placeFold(scroller, 1_300, 0)
    settle(frames)
    act(() => { state.top = 1_200; fireEvent.scroll(scroller) })
    settle(frames)

    fireEvent.click(screen.getByRole('button', { name: /Show the work/ }))
    state.top = 1_000
    settle(frames)

    expect(state.top).toBe(1_000)
  })

  it('files away one already scrolled off the top, without moving a pixel below it', () => {
    // Bottom edge at -636: gone from the viewport entirely.
    const { view, state, fold } = mount(200, 1_200)
    const bottomBefore = fold().getBoundingClientRect().bottom
    expect(fold().hasAttribute('data-folded')).toBe(false)

    send(view)

    expect(fold().hasAttribute('data-folded')).toBe(true)
    // Everything below the fold is where it was: the scroller absorbed the
    // whole shrink, so the collapse cost the reader no on-screen pixel.
    expect(fold().getBoundingClientRect().bottom).toBeCloseTo(bottomBefore, 0)
    expect(state.top).toBe(1_200 - (OPEN_H - CLOSED_H))
  })
})

describe('every answered region carries its control', () => {
  const control = (container: HTMLElement) => container.querySelector('[data-fold-summary]')

  it('offers the toggle in both states on a region open because its answer landed live', () => {
    const { container } = render(<ChatMessages messages={ANSWERED} loading={false} liveFinalResponseId="a1" />)

    expect(container.querySelector('[data-fold-region]')?.getAttribute('aria-hidden')).toBeNull()
    expect(control(container)?.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: /Hide the work/ }))

    expect(control(container)?.getAttribute('aria-expanded')).toBe('false')
  })

  it('offers it on a historical region, which rests closed', () => {
    const { container } = render(<ChatMessages messages={[...ANSWERED, NEXT_ASK]} loading={false} />)

    expect(container.querySelector('[data-fold-region]')?.getAttribute('aria-hidden')).toBe('true')
    expect(control(container)?.getAttribute('aria-expanded')).toBe('false')
  })
})
