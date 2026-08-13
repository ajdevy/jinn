import { vi } from 'vitest'
import { useStickToBottom } from '@/hooks/use-stick-to-bottom'

/**
 * The rig the stick-to-bottom behaviour suite drives the real hook through.
 *
 * jsdom has no layout engine and no ResizeObserver worth the name, so the
 * container gets controllable scroll metrics and the observers get captured —
 * the tests then assert what the hook DOES (does it pin? does it hold the read
 * position? jump/unread state) rather than how it is wired.
 */

export interface CapturedObserver {
  cb: ResizeObserverCallback
  observed: Element[]
}

/** Install synchronous rAF and a capturing ResizeObserver. Call from beforeEach. */
export function stubScrollEnvironment(): CapturedObserver[] {
  const instances: CapturedObserver[] = []
  // Run rAF synchronously so the hook's coalesced UI updates land within act().
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('ResizeObserver', class {
    cb: ResizeObserverCallback
    observed: Element[] = []
    constructor(cb: ResizeObserverCallback) { this.cb = cb; instances.push(this) }
    observe(target: Element) { this.observed.push(target) }
    unobserve(target: Element) {
      this.observed = this.observed.filter((item) => item !== target)
    }
    disconnect() {}
  })
  return instances
}

export function Harness(props: { streamingText?: string; messageCount: number; latestMessageKey?: string | null }) {
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
export function setMetrics(el: HTMLElement, scrollHeight: number, clientHeight: number, scrollTop = 0) {
  let top = scrollTop
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v } })
}

export function dist(el: HTMLElement) {
  return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
}
