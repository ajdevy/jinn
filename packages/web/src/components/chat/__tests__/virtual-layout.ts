import { fireEvent } from '@testing-library/react'
import { vi } from 'vitest'

/**
 * A layout engine for the virtualised transcript, since jsdom has none.
 *
 * The virtualizer sizes the scrollport and every row from `offsetHeight`, which
 * jsdom reports as 0 — and a zero-height scrollport renders NO rows at all, so
 * without this a windowed transcript comes out empty rather than windowed. Rows
 * are all ROW_H tall here and the scrollport VIEWPORT_H, and each row's rect is
 * derived from the `translateY` the virtualizer itself wrote, so what a test
 * reads back is the transcript's own arithmetic and not a second model of it.
 *
 * Install it BEFORE rendering: the first measurement happens on mount.
 */

export interface VirtualLayout {
  /** Distance from the scrollport's top edge to this message's top edge. */
  offsetOf: (messageId: string) => number
  /** Mounted `[data-message-id]` rows, in DOM order. */
  mountedMessageIds: () => string[]
  /** Those of them the reader can actually see. */
  visibleMessageIds: () => string[]
  scrollTop: () => number
  scrollTo: (top: number) => void
  scrollToBottom: () => void
  release: () => void
}

const domRect = (top: number, height: number): DOMRect => ({
  top, bottom: top + height, height, left: 0, right: 500, width: 500, x: 0, y: top,
  toJSON: () => ({}),
}) as DOMRect

function rowStart(host: HTMLElement): number {
  return Number(/translateY\((-?[\d.]+)px\)/.exec(host.style.transform)?.[1] ?? 0)
}

export function installVirtualLayout(rowHeight: number, viewportHeight: number): VirtualLayout {
  let scrollTop = 0
  let bound: HTMLDivElement | null = null
  let contentHeight = () => 0

  const isScroller = (el: HTMLElement) => el.classList.contains('chat-messages-scroll')
  const heightSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
    .mockImplementation(function (this: HTMLElement) {
      if (isScroller(this)) return viewportHeight
      return this.hasAttribute('data-index') ? rowHeight : 0
    })
  const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      if (isScroller(this)) return domRect(0, viewportHeight)
      const host = this.closest<HTMLElement>('[data-index]')
      return host ? domRect(rowStart(host) - scrollTop, rowHeight) : domRect(0, 0)
    })

  // The scroller only exists once the transcript has rendered, and its scroll
  // position has to be ours from then on — jsdom's own is a constant zero.
  function scroller(): HTMLDivElement {
    const node = document.querySelector('.chat-messages-scroll') as HTMLDivElement
    if (node === bound) return node
    bound = node
    Object.defineProperty(node, 'clientHeight', { configurable: true, get: () => viewportHeight })
    // The spacer the virtualizer sizes IS the scrollable content, so reading its
    // height back is what a browser would report for the scroller.
    contentHeight = () => {
      const spacer = node.querySelector<HTMLElement>('[data-index]')?.parentElement
      return spacer ? parseFloat(spacer.style.height) || 0 : 0
    }
    Object.defineProperty(node, 'scrollHeight', { configurable: true, get: contentHeight })
    // Browsers clamp; without it a scroll past the end would stay past the end.
    Object.defineProperty(node, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (next: number) => {
        scrollTop = Math.max(0, Math.min(next, Math.max(0, contentHeight() - viewportHeight)))
      },
    })
    node.scrollTo = ((options: ScrollToOptions) => {
      node.scrollTop = options.top ?? 0
      fireEvent.scroll(node)
    }) as HTMLElement['scrollTo']
    return node
  }

  const mountedRows = () =>
    Array.from(scroller().querySelectorAll<HTMLElement>('[data-message-id]'))

  return {
    offsetOf: (messageId) => {
      const row = scroller().querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)
      if (!row) throw new Error(`message ${messageId} is not mounted`)
      return row.getBoundingClientRect().top
    },
    mountedMessageIds: () => mountedRows().map((row) => row.getAttribute('data-message-id') ?? ''),
    visibleMessageIds: () => mountedRows()
      .filter((row) => {
        const rect = row.getBoundingClientRect()
        return rect.bottom > 0 && rect.top < viewportHeight
      })
      .map((row) => row.getAttribute('data-message-id') ?? ''),
    scrollTop: () => scrollTop,
    scrollTo: (top) => {
      scroller().scrollTop = top
      fireEvent.scroll(scroller())
    },
    scrollToBottom: () => {
      scroller().scrollTop = contentHeight()
      fireEvent.scroll(scroller())
    },
    release: () => { heightSpy.mockRestore(); rectSpy.mockRestore() },
  }
}
