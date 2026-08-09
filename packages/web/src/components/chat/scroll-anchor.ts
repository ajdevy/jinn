/**
 * Read-position anchoring for the transcript's older-message pages.
 *
 * Prepending a page inserts content ABOVE the viewport, which moves everything
 * the reader is looking at down by the height of that page. The fix is to note
 * where a visible message sits before the insert and put it back afterwards.
 */

/** How close to the top the reader must get before the next older page is requested. */
export const OLDER_LOAD_THRESHOLD_PX = 900

export interface ScrollAnchor {
  /** The message the read position is measured against. */
  id: string | null
  /** Its distance from the scrollport's top edge when the anchor was taken. */
  offset: number
  scrollHeight: number
  scrollTop: number
  /**
   * Identity of the first rendered message at capture time. Only a commit that
   * changes it has prepended anything, and only that commit may spend the anchor.
   */
  firstMessageId: string | null
}

/** Anchor on the topmost message intersecting the scrollport. */
export function captureVisibleAnchor(node: HTMLDivElement, firstMessageId: string | null): ScrollAnchor {
  const containerRect = node.getBoundingClientRect()
  const base = { scrollHeight: node.scrollHeight, scrollTop: node.scrollTop, firstMessageId }
  const rows = Array.from(node.querySelectorAll<HTMLElement>('[data-message-id]'))
  for (const row of rows) {
    const rect = row.getBoundingClientRect()
    if (rect.bottom >= containerRect.top && rect.top <= containerRect.bottom) {
      return { id: row.getAttribute('data-message-id'), offset: rect.top - containerRect.top, ...base }
    }
  }
  return { id: null, offset: 0, ...base }
}

/**
 * Put the anchored message back where it was. Measuring the row itself absorbs
 * whatever height the inserted page turned out to have; the scrollHeight delta
 * is only the fallback for when that row is no longer rendered.
 */
export function restoreVisibleAnchor(node: HTMLDivElement, anchor: ScrollAnchor) {
  if (anchor.id) {
    const target = Array.from(node.querySelectorAll<HTMLElement>('[data-message-id]'))
      .find((row) => row.getAttribute('data-message-id') === anchor.id)
    if (target) {
      const containerRect = node.getBoundingClientRect()
      node.scrollTop += target.getBoundingClientRect().top - containerRect.top - anchor.offset
      return
    }
  }
  node.scrollTop = anchor.scrollTop + (node.scrollHeight - anchor.scrollHeight)
}
