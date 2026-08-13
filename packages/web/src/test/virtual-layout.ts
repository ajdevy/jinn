import { fireEvent } from '@testing-library/react'
import { vi } from 'vitest'

/**
 * A layout engine for any virtualised list, since jsdom has none.
 *
 * The virtualizer sizes the scrollport and every row from `offsetHeight`, which
 * jsdom reports as 0 — and a zero-height scrollport renders NO rows at all, so
 * without this a windowed list comes out empty rather than windowed. Rows are
 * all ROW_H tall here and the scrollport VIEWPORT_H, and each row's rect is
 * derived from the `translateY` the virtualizer itself wrote, so what a test
 * reads back is the list's own arithmetic and not a second model of it.
 *
 * Install it BEFORE rendering: the first measurement happens on mount.
 */

/** Which DOM the harness should drive — one virtualised surface's selectors. */
export interface VirtualLayoutTargets {
  /** Selector for the scrollport the virtualizer measures. */
  scroller: string
  /** Selector matching one rendered row. */
  row: string
  /** The attribute on that row carrying its identity. */
  rowId: string
}

export interface VirtualLayout {
  /** Distance from the scrollport's top edge to this row's top edge. */
  offsetOf: (rowId: string) => number
  /** Mounted rows, in DOM order, by their identity attribute. */
  mountedRowIds: () => string[]
  /** Those of them the reader can actually see. */
  visibleRowIds: () => string[]
  scrollTop: () => number
  scrollTo: (top: number) => void
  scrollToBottom: () => void
  release: () => void
}

/** The one scroll position the spies and the scroller both read and write. */
interface ScrollState {
  top: number
  contentHeight: () => number
}

const domRect = (top: number, height: number): DOMRect => ({
  top, bottom: top + height, height, left: 0, right: 500, width: 500, x: 0, y: top,
  toJSON: () => ({}),
}) as DOMRect

function rowStart(host: HTMLElement): number {
  return Number(/translateY\((-?[\d.]+)px\)/.exec(host.style.transform)?.[1] ?? 0)
}

/** Teach jsdom the one geometry this harness models. Returns the undo. */
function installMeasurementSpies(
  rowHeight: number,
  viewportHeight: number,
  targets: VirtualLayoutTargets,
  state: ScrollState,
): () => void {
  const isScroller = (el: HTMLElement) => el.matches(targets.scroller)
  const heightSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
    .mockImplementation(function (this: HTMLElement) {
      if (isScroller(this)) return viewportHeight
      return this.hasAttribute('data-index') ? rowHeight : 0
    })
  const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      if (isScroller(this)) return domRect(0, viewportHeight)
      const host = this.closest<HTMLElement>('[data-index]')
      return host ? domRect(rowStart(host) - state.top, rowHeight) : domRect(0, 0)
    })
  return () => { heightSpy.mockRestore(); rectSpy.mockRestore() }
}

/** Give one scroller the scroll position jsdom keeps at a constant zero. */
function bindScroller(node: HTMLDivElement, viewportHeight: number, state: ScrollState): void {
  Object.defineProperty(node, 'clientHeight', { configurable: true, get: () => viewportHeight })
  // The spacer the virtualizer sizes IS the scrollable content, so reading its
  // height back is what a browser would report for the scroller.
  state.contentHeight = () => {
    const spacer = node.querySelector<HTMLElement>('[data-index]')?.parentElement
    return spacer ? parseFloat(spacer.style.height) || 0 : 0
  }
  Object.defineProperty(node, 'scrollHeight', { configurable: true, get: () => state.contentHeight() })
  // Browsers clamp; without it a scroll past the end would stay past the end.
  Object.defineProperty(node, 'scrollTop', {
    configurable: true,
    get: () => state.top,
    set: (next: number) => {
      state.top = Math.max(0, Math.min(next, Math.max(0, state.contentHeight() - viewportHeight)))
    },
  })
  node.scrollTo = ((options: ScrollToOptions) => {
    node.scrollTop = options.top ?? 0
    fireEvent.scroll(node)
  }) as HTMLElement['scrollTo']
}

/** The three read-only questions a test asks about the mounted rows. */
function rowQueries(
  scroller: () => HTMLDivElement,
  targets: VirtualLayoutTargets,
  viewportHeight: number,
): Pick<VirtualLayout, 'offsetOf' | 'mountedRowIds' | 'visibleRowIds'> {
  const mountedRows = () => Array.from(scroller().querySelectorAll<HTMLElement>(targets.row))
  const idOf = (row: HTMLElement) => row.getAttribute(targets.rowId) ?? ''
  return {
    offsetOf: (id) => {
      const row = scroller().querySelector<HTMLElement>(`[${targets.rowId}="${id}"]`)
      if (!row) throw new Error(`row ${id} is not mounted`)
      return row.getBoundingClientRect().top
    },
    mountedRowIds: () => mountedRows().map(idOf),
    visibleRowIds: () => mountedRows()
      .filter((row) => {
        const rect = row.getBoundingClientRect()
        return rect.bottom > 0 && rect.top < viewportHeight
      })
      .map(idOf),
  }
}

export function installVirtualLayout(
  rowHeight: number,
  viewportHeight: number,
  targets: VirtualLayoutTargets,
): VirtualLayout {
  const state: ScrollState = { top: 0, contentHeight: () => 0 }
  const release = installMeasurementSpies(rowHeight, viewportHeight, targets, state)

  // The scroller only exists once the list has rendered, so it is bound lazily.
  let bound: HTMLDivElement | null = null
  const scroller = (): HTMLDivElement => {
    const node = document.querySelector(targets.scroller) as HTMLDivElement
    if (node !== bound) {
      bound = node
      bindScroller(node, viewportHeight, state)
    }
    return node
  }

  const scrollTo = (top: number) => {
    scroller().scrollTop = top
    fireEvent.scroll(scroller())
  }
  // Binding the scroller is what teaches `state` the content height, so asking
  // for it before the first `scroller()` call would answer zero.
  const contentHeight = () => {
    scroller()
    return state.contentHeight()
  }

  return {
    ...rowQueries(scroller, targets, viewportHeight),
    scrollTop: () => state.top,
    scrollTo,
    scrollToBottom: () => scrollTo(contentHeight()),
    release,
  }
}
