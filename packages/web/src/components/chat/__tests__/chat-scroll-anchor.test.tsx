import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import type { Message } from '@/lib/conversations'
import { ChatMessages } from '../chat-messages'

/**
 * Prepend anchoring on a real older-message page.
 *
 * jsdom has no layout engine, so the transcript is given one: every message row
 * is ROW_H tall, the scrollport is VIEWPORT_H tall, and `getBoundingClientRect`
 * is derived from a row's position in the CURRENT message list minus scrollTop.
 * That makes "where is this message on screen" a number the test can read before
 * and after a prepend, which is exactly what the anchor is supposed to hold.
 *
 * Every message is a user message on purpose: user rows never fold and never
 * group, so the list is one `[data-message-id]` row per message and the model
 * above stays true.
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

interface Viewport {
  scroller: HTMLDivElement
  /** Distance from the scrollport's top edge to this message's top edge. */
  offsetOf: (id: string) => number
  release: () => void
}

/** Install the fake layout on the mounted scroller; `order` is read live. */
function installViewport(order: () => Message[]): Viewport {
  const scroller = document.querySelector('.chat-messages-scroll') as HTMLDivElement
  const indexOf = (id: string) => order().findIndex((message) => message.id === id)
  const scrollHeight = () => order().length * ROW_H
  let scrollTop = 0

  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => VIEWPORT_H })
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight() })
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    // Browsers clamp; without this the mount-snap would leave scrollTop past the end.
    set: (next: number) => {
      scrollTop = Math.max(0, Math.min(next, Math.max(0, scrollHeight() - VIEWPORT_H)))
    },
  })

  const offsetOf = (id: string) => indexOf(id) * ROW_H - scrollTop
  const rect = (top: number, height: number) => ({
    top, bottom: top + height, height, left: 0, right: 500, width: 500, x: 0, y: top, toJSON: () => ({}),
  })
  const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('chat-messages-scroll')) return rect(0, VIEWPORT_H) as DOMRect
    const id = this.getAttribute('data-message-id')
    const index = id ? indexOf(id) : -1
    if (index < 0) return rect(0, 0) as DOMRect
    return rect(offsetOf(id as string), ROW_H) as DOMRect
  })

  return { scroller, offsetOf, release: () => spy.mockRestore() }
}

/** A promise the test resolves by hand, so the page can land mid-flight. */
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

afterEach(() => { vi.restoreAllMocks() })

describe('ChatMessages older-page anchoring', () => {
  it('holds the read position when a full older page is prepended', () => {
    const initial = transcript(100, 150)
    const older = transcript(0, OLDER_PAGE)
    let messages = initial
    const page = deferred()

    const view = (list: Message[], hasOlder: boolean) => (
      <ChatMessages
        messages={list}
        loading={false}
        hasOlderMessages={hasOlder}
        onLoadOlderMessages={() => page.promise}
      />
    )
    const { rerender } = render(view(initial, true))
    const vp = installViewport(() => messages)

    // Read up until the older-page load fires (scrollTop <= OLDER_LOAD_THRESHOLD_PX).
    act(() => { vp.scroller.scrollTop = 500; fireEvent.scroll(vp.scroller) })
    const before = vp.offsetOf('m110')
    expect(before).toBe(500)

    // The page lands.
    messages = [...older, ...initial]
    act(() => {
      page.resolve()
      rerender(view(messages, false))
    })

    expect(Math.abs(vp.offsetOf('m110') - before)).toBeLessThanOrEqual(4)
    vp.release()
  })

  it('still holds it when a new message is appended while the page is in flight', () => {
    // The regression: any `messages` change used to consume the pending anchor,
    // so an assistant reply arriving mid-flight spent the correction on a commit
    // that moved nothing, and the real prepend landed uncorrected.
    const initial = transcript(100, 150)
    const older = transcript(0, OLDER_PAGE)
    const appended: Message[] = [{ id: 'm250', role: 'user', content: 'live', timestamp: 1_800_000_000_000 }]
    let messages = initial
    const page = deferred()

    const view = (list: Message[], hasOlder: boolean) => (
      <ChatMessages
        messages={list}
        loading={false}
        hasOlderMessages={hasOlder}
        onLoadOlderMessages={() => page.promise}
      />
    )
    const { rerender } = render(view(initial, true))
    const vp = installViewport(() => messages)

    act(() => { vp.scroller.scrollTop = 500; fireEvent.scroll(vp.scroller) })
    const before = vp.offsetOf('m110')
    expect(before).toBe(500)

    // A message arrives below the read position while the request is still open.
    messages = [...initial, ...appended]
    act(() => { rerender(view(messages, true)) })
    expect(vp.offsetOf('m110')).toBe(before)

    // Now the older page lands.
    messages = [...older, ...initial, ...appended]
    act(() => {
      page.resolve()
      rerender(view(messages, false))
    })

    expect(Math.abs(vp.offsetOf('m110') - before)).toBeLessThanOrEqual(4)
    vp.release()
  })
})
