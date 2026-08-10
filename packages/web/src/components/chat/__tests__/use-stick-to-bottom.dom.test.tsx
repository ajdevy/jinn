import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, fireEvent } from '@testing-library/react'
import { useStickToBottom, STICK_THRESHOLD_PX } from '@/hooks/use-stick-to-bottom'

// Drives the REAL hook through every scroll failure mode the rebuild targets.
// jsdom has no layout engine, so we install controllable scrollHeight/clientHeight/
// scrollTop on the container and a captured ResizeObserver, then assert the hook's
// observable behaviour (does it pin? does it preserve position? jump/unread state).

let roInstances: Array<{ cb: ResizeObserverCallback; observed: Element[] }> = []

beforeEach(() => {
  roInstances = []
  // Run rAF synchronously so the hook's coalesced UI updates land within act().
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('ResizeObserver', class {
    cb: ResizeObserverCallback
    observed: Element[] = []
    constructor(cb: ResizeObserverCallback) { this.cb = cb; roInstances.push(this) }
    observe(target: Element) { this.observed.push(target) }
    unobserve(target: Element) {
      this.observed = this.observed.filter((item) => item !== target)
    }
    disconnect() {}
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function Harness(props: { streamingText?: string; messageCount: number; latestMessageKey?: string | null }) {
  const { containerRef, showJump, unreadCount, scrollToBottom } = useStickToBottom(props)
  return (
    <div>
      <div data-testid="scroller" ref={containerRef}>
        <div data-testid="content">content</div>
      </div>
      <span data-testid="jump">{showJump ? 'show' : 'hide'}</span>
      <span data-testid="unread">{unreadCount}</span>
      <button data-testid="btn" onClick={() => scrollToBottom('auto')}>jump</button>
      <button data-testid="btn-smooth" onClick={() => scrollToBottom('smooth')}>jump smoothly</button>
    </div>
  )
}

/** Install controllable scroll metrics on the element (jsdom defaults them to 0). */
function setMetrics(el: HTMLElement, scrollHeight: number, clientHeight: number, scrollTop = 0) {
  let top = scrollTop
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v } })
}

function dist(el: HTMLElement) {
  return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
}

describe('useStickToBottom — behaviour', () => {
  it('mount-snap: pins to the bottom the first time messages appear', () => {
    const { getByTestId, rerender } = render(<Harness messageCount={0} />)
    const el = getByTestId('scroller')
    setMetrics(el, 1000, 200, 0)
    act(() => { rerender(<Harness messageCount={5} />) })
    expect(dist(el)).toBe(0) // pinned
  })

  it('streaming-follow: stays pinned as content grows while at the bottom', () => {
    const { getByTestId, rerender } = render(<Harness messageCount={0} streamingText="" />)
    const el = getByTestId('scroller')
    setMetrics(el, 1000, 200, 0)
    act(() => { rerender(<Harness messageCount={5} streamingText="" />) })
    expect(dist(el)).toBe(0)
    // Content grows over several stream ticks — must remain pinned (no detach).
    for (const [h, text] of [[1400, 'a'], [2200, 'ab'], [3600, 'abc']] as const) {
      setMetrics(el, h, 200, el.scrollTop)
      act(() => { rerender(<Harness messageCount={5} streamingText={text} />) })
      expect(dist(el)).toBe(0)
    }
  })

  it('read-up-preserve: scrolling up detaches and a later message does NOT yank back', () => {
    const { getByTestId, rerender } = render(<Harness messageCount={0} />)
    const el = getByTestId('scroller')
    setMetrics(el, 1000, 200, 0)
    act(() => { rerender(<Harness messageCount={5} />) }) // caught up, seen=5
    // User scrolls up well past the threshold.
    act(() => { el.scrollTop = 300; fireEvent.scroll(el) })
    expect(getByTestId('jump').textContent).toBe('show')
    const posBeforeGrowth = el.scrollTop
    // A new message arrives while reading up — position must be preserved.
    setMetrics(el, 1600, 200, el.scrollTop)
    act(() => { rerender(<Harness messageCount={6} />) })
    expect(el.scrollTop).toBe(posBeforeGrowth) // not yanked
    expect(getByTestId('unread').textContent).toBe('1') // one new message counted
  })

  it('threshold: within STICK_THRESHOLD_PX still counts as at-bottom (re-engages follow)', () => {
    const { getByTestId, rerender } = render(<Harness messageCount={0} />)
    const el = getByTestId('scroller')
    setMetrics(el, 1000, 200, 0)
    act(() => { rerender(<Harness messageCount={5} />) })
    // Detach first.
    act(() => { el.scrollTop = 200; fireEvent.scroll(el) })
    expect(getByTestId('jump').textContent).toBe('show')
    // Nudge back to within the threshold of the bottom (dist = 1000-790-200 = 10).
    act(() => { el.scrollTop = 1000 - 200 - (STICK_THRESHOLD_PX - 1); fireEvent.scroll(el) })
    expect(getByTestId('jump').textContent).toBe('hide')
    // Re-engaged for real: the next growth pins again.
    setMetrics(el, 1400, 200, el.scrollTop)
    act(() => { rerender(<Harness messageCount={6} />) })
    expect(dist(el)).toBe(0)
  })

  it('resize/keyboard: a viewport resize re-pins while following', () => {
    const { getByTestId, rerender } = render(<Harness messageCount={0} />)
    const el = getByTestId('scroller')
    setMetrics(el, 1000, 200, 0)
    act(() => { rerender(<Harness messageCount={5} />) }) // following
    // Simulate the mobile keyboard: content unchanged, but the container shrank and
    // drifted off the bottom. The viewport ResizeObserver must re-pin.
    el.scrollTop = 600
    act(() => { roInstances.forEach((r) => r.cb([], {} as ResizeObserver)) })
    expect(dist(el)).toBe(0)
  })

  it('content-growth: re-pins when rendered media/content grows while following', () => {
    const { getByTestId, rerender } = render(<Harness messageCount={0} />)
    const el = getByTestId('scroller')
    const content = getByTestId('content')
    setMetrics(el, 1000, 200, 0)
    act(() => { rerender(<Harness messageCount={5} />) }) // following
    expect(dist(el)).toBe(0)

    // An image/media decode can grow the rendered content without changing the
    // message count or streaming text. The content observer must keep following
    // pinned users at the true bottom.
    setMetrics(el, 1400, 200, el.scrollTop)
    const contentObservers = roInstances.filter((r) => r.observed.includes(content))
    act(() => { contentObservers.forEach((r) => r.cb([], {} as ResizeObserver)) })
    expect(dist(el)).toBe(0)
  })

  it('tab-return: visibilitychange re-pins while following', () => {
    const { getByTestId, rerender } = render(<Harness messageCount={0} />)
    const el = getByTestId('scroller')
    setMetrics(el, 1000, 200, 0)
    act(() => { rerender(<Harness messageCount={5} />) }) // following
    el.scrollTop = 500 // drift accrued while backgrounded
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    act(() => { fireEvent(document, new Event('visibilitychange')) })
    expect(dist(el)).toBe(0)
  })

  it('jump button: returns to bottom, hides itself, and clears unread', () => {
    const { getByTestId, rerender } = render(<Harness messageCount={0} />)
    const el = getByTestId('scroller')
    setMetrics(el, 1000, 200, 0)
    act(() => { rerender(<Harness messageCount={5} />) })
    act(() => { el.scrollTop = 100; fireEvent.scroll(el) })
    expect(getByTestId('jump').textContent).toBe('show')
    act(() => { fireEvent.click(getByTestId('btn')) })
    expect(dist(el)).toBe(0)
    expect(getByTestId('jump').textContent).toBe('hide')
    expect(getByTestId('unread').textContent).toBe('0')
  })

  it('unread accumulates per new message while detached', () => {
    const { getByTestId, rerender } = render(<Harness messageCount={0} />)
    const el = getByTestId('scroller')
    setMetrics(el, 1000, 200, 0)
    act(() => { rerender(<Harness messageCount={5} />) })
    act(() => { el.scrollTop = 100; fireEvent.scroll(el) }) // detach, seen=5
    setMetrics(el, 1200, 200, el.scrollTop)
    act(() => { rerender(<Harness messageCount={6} />) })
    expect(getByTestId('unread').textContent).toBe('1')
    setMetrics(el, 1400, 200, el.scrollTop)
    act(() => { rerender(<Harness messageCount={7} />) })
    expect(getByTestId('unread').textContent).toBe('2')
  })

  it('does not count prepended history as unread while detached', () => {
    const { getByTestId, rerender } = render(<Harness messageCount={0} />)
    const el = getByTestId('scroller')
    setMetrics(el, 10000, 1000, 0)
    act(() => { rerender(<Harness messageCount={150} latestMessageKey="m220" />) })
    act(() => { el.scrollTop = 700; fireEvent.scroll(el) })
    expect(getByTestId('jump').textContent).toBe('show')
    expect(getByTestId('unread').textContent).toBe('0')

    setMetrics(el, 15000, 1000, el.scrollTop)
    act(() => { rerender(<Harness messageCount={220} latestMessageKey="m220" />) })
    expect(getByTestId('unread').textContent).toBe('0')

    setMetrics(el, 15200, 1000, el.scrollTop)
    act(() => { rerender(<Harness messageCount={221} latestMessageKey="m221" />) })
    expect(getByTestId('unread').textContent).toBe('1')
  })

  it('sub-threshold scroll-up detaches, so settling content cannot yank the reader back', () => {
    const { getByTestId, rerender } = render(<Harness messageCount={0} />)
    const el = getByTestId('scroller')
    const content = getByTestId('content')
    setMetrics(el, 1000, 200, 0)
    act(() => { rerender(<Harness messageCount={5} />) }) // pinned, following
    expect(dist(el)).toBe(0)

    // A trackpad nudge that lands INSIDE the threshold band (dist 0 → 10). Deciding
    // follow by distance alone kept it engaged here, and every re-pin below undid it.
    act(() => { el.scrollTop = 1000 - 200 - 10; fireEvent.scroll(el) })
    expect(dist(el)).toBe(10)
    expect(getByTestId('jump').textContent).toBe('show')
    const readingPos = el.scrollTop

    // A freshly opened transcript keeps resizing for a second or two (arrival and
    // fold animations, code highlighting, image decode). Every fire must be a no-op.
    const contentObservers = roInstances.filter((r) => r.observed.includes(content))
    for (let i = 0; i < 3; i++) {
      act(() => { contentObservers.forEach((r) => r.cb([], {} as ResizeObserver)) })
      expect(el.scrollTop).toBe(readingPos)
    }

    // …and so must a new message arriving underneath.
    setMetrics(el, 1200, 200, el.scrollTop)
    act(() => { rerender(<Harness messageCount={6} />) })
    expect(el.scrollTop).toBe(readingPos)
    expect(getByTestId('unread').textContent).toBe('1')
  })

  it('bottom clamp: scrollTop drops while still at the bottom — follow survives', () => {
    const { getByTestId, rerender } = render(<Harness messageCount={0} />)
    const el = getByTestId('scroller')
    setMetrics(el, 1000, 200, 0)
    act(() => { rerender(<Harness messageCount={5} />) }) // pinned, following
    expect(dist(el)).toBe(0)

    // Content ABOVE shrinks (a fold region collapsing mid-stream): the browser clamps
    // scrollTop down and fires a scroll event. scrollTop decreased, yet we never left
    // the bottom — a scroll-direction check would falsely detach the live stream.
    setMetrics(el, 700, 200, 500)
    act(() => { fireEvent.scroll(el) })
    expect(dist(el)).toBe(0)
    expect(getByTestId('jump').textContent).toBe('hide')

    // Still following: the next growth pins.
    setMetrics(el, 1100, 200, el.scrollTop)
    act(() => { rerender(<Harness messageCount={6} />) })
    expect(dist(el)).toBe(0)
  })

  it('within the threshold: a new message pins the reader to the bottom', () => {
    const { getByTestId, rerender } = render(<Harness messageCount={0} />)
    const el = getByTestId('scroller')
    setMetrics(el, 1000, 200, 0)
    act(() => { rerender(<Harness messageCount={5} />) })
    // Read up, then scroll back down and stop just inside the band — the way a
    // user actually arrives within STICK_THRESHOLD_PX of the bottom.
    act(() => { el.scrollTop = 200; fireEvent.scroll(el) })
    act(() => { el.scrollTop = 1000 - 200 - (STICK_THRESHOLD_PX - 1); fireEvent.scroll(el) })
    expect(dist(el)).toBe(STICK_THRESHOLD_PX - 1)

    setMetrics(el, 1300, 200, el.scrollTop)
    act(() => { rerender(<Harness messageCount={6} latestMessageKey="m6" />) })

    expect(dist(el)).toBe(0)
    expect(getByTestId('jump').textContent).toBe('hide')
    expect(getByTestId('unread').textContent).toBe('0')
  })

  it('an unfinished smooth jump does not swallow the user\'s next scroll', () => {
    const { getByTestId, rerender } = render(<Harness messageCount={0} />)
    const el = getByTestId('scroller')
    el.scrollTo = () => {} // jsdom has none; the hook takes the smooth branch when it exists
    setMetrics(el, 1000, 200, 0)
    act(() => { rerender(<Harness messageCount={5} />) })
    act(() => { el.scrollTop = 100; fireEvent.scroll(el) }) // detach, seen=5
    act(() => { fireEvent.click(getByTestId('btn-smooth')) })

    // The animation is still short of the bottom when content grows past its
    // target, so it never reports arrival. Suppression used to latch on there and
    // every later scroll event returned early — leaving the reader permanently
    // followed, with no jump affordance and no unread count.
    setMetrics(el, 1600, 200, 700)
    act(() => { fireEvent.scroll(el) })
    act(() => { el.scrollTop = 300; fireEvent.scroll(el) }) // user reads up again
    const readingPos = el.scrollTop

    expect(getByTestId('jump').textContent).toBe('show')
    setMetrics(el, 1900, 200, el.scrollTop)
    act(() => { rerender(<Harness messageCount={6} latestMessageKey="m6" />) })
    expect(el.scrollTop).toBe(readingPos)
    expect(getByTestId('unread').textContent).toBe('1')
  })
})
