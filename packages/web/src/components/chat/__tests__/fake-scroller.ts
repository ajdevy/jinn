import { vi } from 'vitest'

/** The scrollport height the transcript scroller tests measure against. */
export const SCROLLER_HEIGHT = 200

/** A scroller with the metrics jsdom does not have, and a spy where the writes land. */
export function fakeScroller(scrollHeight: () => number) {
  const el = document.createElement('div')
  let top = 0
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => SCROLLER_HEIGHT })
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v } })
  const scrollTo = vi.fn((options: ScrollToOptions) => { top = options.top ?? top })
  el.scrollTo = scrollTo as unknown as HTMLDivElement['scrollTo']
  document.body.append(el)
  return { el, scrollTo }
}
