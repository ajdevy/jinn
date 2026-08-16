import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import type { Message } from '@/lib/conversations'
import { ChatMessages } from '../chat-messages'
import { installVirtualLayout } from './virtual-layout'

/**
 * Media decoding into a row of a windowed transcript.
 *
 * The row grows without the message count or the streaming text changing, so
 * the growth-follow layout effect never runs: the only thing that notices is
 * the content ResizeObserver. Where that observer pins to is what this file is
 * about. It has to reach the bottom the way this transcript can reach it —
 * through the virtualizer, which resolves it to the scroller's own maximum —
 * rather than by a raw `scrollTop = scrollHeight` write, which aims at the
 * estimate the window is currently painting and leaves the transcript unaware
 * that the position moved at all.
 *
 * `virtual-layout.ts` supplies the jsdom layout the virtualizer needs, with the
 * media row resolving taller than its neighbours once it has "decoded". Every
 * message is a user message on purpose: user rows never fold and never group,
 * so one message is one virtual row.
 */

/** Matches the virtualizer's resting estimate for a plain message row, so the
 *  harness measures back exactly the arithmetic the virtualizer did. */
const ROW_H = 140
const VIEWPORT_H = 700
const COUNT = 60
const MEDIA_H = 600
const MEDIA_ID = `v${COUNT - 1}`

interface CapturedObserver { cb: ResizeObserverCallback; observed: Element[] }

/** What a browser hands a ResizeObserver callback. The virtualizer measures off
 *  `offsetHeight` whenever the entry carries no box size, which is where the
 *  layout harness answers. */
const resized = (target: Element) => (
  [{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry]
)

/** Capture every ResizeObserver, delivering on `observe` as the suite's default
 *  stub does — the virtualizer measures through one of these too, so changing
 *  when they fire would change what the transcript itself sees. */
function captureResizeObservers(): CapturedObserver[] {
  const instances: CapturedObserver[] = []
  vi.stubGlobal('ResizeObserver', class {
    cb: ResizeObserverCallback
    observed: Element[] = []
    constructor(cb: ResizeObserverCallback) { this.cb = cb; instances.push(this) }
    observe(target: Element) {
      this.observed.push(target)
      this.cb(resized(target), this as unknown as ResizeObserver)
    }
    unobserve(target: Element) { this.observed = this.observed.filter((el) => el !== target) }
    disconnect() {}
  })
  return instances
}

const thread: Message[] = Array.from({ length: COUNT }, (_, index) => ({
  id: `v${index}`,
  role: 'user' as const,
  content: `message ${index}`,
  timestamp: 1_700_000_000_000 + index * 60_000,
}))

/** Every scroll write the scroller took, and whether it came through the
 *  transcript's own `scrollTo` path or straight onto `scrollTop`. */
function recordScrollWrites(node: HTMLDivElement): string[] {
  const writes: string[] = []
  let routed = false
  const scrollTo = node.scrollTo.bind(node)
  node.scrollTo = ((options: ScrollToOptions) => {
    routed = true
    try { scrollTo(options) } finally { routed = false }
  }) as HTMLElement['scrollTo']
  const own = Object.getOwnPropertyDescriptor(node, 'scrollTop')!
  Object.defineProperty(node, 'scrollTop', {
    configurable: true,
    get: own.get,
    set: (top: number) => { writes.push(routed ? 'virtualizer' : 'raw'); own.set!.call(node, top) },
  })
  return writes
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('ChatMessages media growth on a virtualised thread', () => {
  it('re-pins a following reader to the true bottom, through the virtualizer', () => {
    let mediaGrown = false
    const observers = captureResizeObservers()
    const layout = installVirtualLayout(
      (row) => (row.querySelector(`[data-message-id="${MEDIA_ID}"]`) && mediaGrown ? ROW_H + MEDIA_H : ROW_H),
      VIEWPORT_H,
    )
    render(<ChatMessages messages={thread} loading={false} />)
    act(() => { layout.scrollToBottom() })

    const scroller = document.querySelector('.chat-messages-scroll') as HTMLDivElement
    const content = scroller.firstElementChild as HTMLElement
    const contentObserver = observers.find((observer) => observer.observed.includes(content))!
    const rowObserver = observers.find((observer) => observer.observed.some((el) => el.hasAttribute('data-index')))!
    const settled = layout.scrollTop()
    expect(settled).toBe(COUNT * ROW_H - VIEWPORT_H)

    // The media decodes and the virtualizer re-measures its row. Rows are
    // absolutely positioned inside the spacer, so nothing the content observer
    // watches changes until that commit has resized the spacer around them.
    mediaGrown = true
    const mediaRow = scroller.querySelector(`[data-message-id="${MEDIA_ID}"]`)!.closest('[data-index]')!
    act(() => { rowObserver.cb(resized(mediaRow), rowObserver as unknown as ResizeObserver) })
    expect(layout.scrollTop()).toBe(settled)
    expect(scroller.scrollHeight).toBe(COUNT * ROW_H + MEDIA_H)

    const writes = recordScrollWrites(scroller)
    act(() => { contentObserver.cb(resized(content), contentObserver as unknown as ResizeObserver) })

    expect(writes).toContain('virtualizer')
    expect(writes).not.toContain('raw')
    expect(layout.scrollTop()).toBe(COUNT * ROW_H + MEDIA_H - VIEWPORT_H)
    expect(layout.visibleMessageIds()).toContain(MEDIA_ID)
    layout.release()
  })
})
