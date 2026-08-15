/**
 * Scroll compensation for a folding region.
 *
 * A fold changes its own height while the reader is looking at the transcript,
 * so everything below it would jump. These two pieces decide whether the
 * scroller can absorb that change and hold the content below it still while it
 * happens. They live apart from the component because the component is about
 * the choreography and these are about the scroller.
 */

/** How long the compensation follows a fold, in ms. */
export const ANCHOR_WINDOW_MS = 480

/** Resting height of the summary ledger line (min-h-8). */
export const FOLD_SUMMARY_PX = 32

/**
 * The anchored live fold only plays when the scroller can absorb the shrink:
 * compensation scrolls UP by (region height - summary height), and scrollTop
 * cannot go below 0. Without that slack the animated path would yank content
 * up by the remainder, so callers use an instant fold instead.
 */
export function canAnchorFold(scrollSlack: number, regionHeight: number, summaryHeight = FOLD_SUMMARY_PX): boolean {
  return scrollSlack + 2 >= regionHeight - summaryHeight
}

export interface AnchorScrollOptions {
  /** Anchor to a position captured BEFORE a same-frame insertion (the summary
   *  row), so the insertion itself gets compensated too. */
  referenceBottom?: number
  /** Injectable for tests. */
  raf?: (cb: FrameRequestCallback) => number
  /** Injectable for tests. */
  now?: () => number
}

/**
 * Per-frame scroll compensation: keeps everything below `anchorEl` pixel-fixed
 * while its height changes. Returns a cancel function so an interrupted toggle
 * can re-anchor from the current position instead of fighting the stale loop.
 */
export function anchorScrollDuring(
  scroller: Element | null,
  anchorEl: Element,
  durationMs: number,
  { referenceBottom, raf = (cb) => requestAnimationFrame(cb), now = () => performance.now() }: AnchorScrollOptions = {},
): () => void {
  if (!scroller) return () => {}
  let cancelled = false
  const bottom0 = referenceBottom ?? anchorEl.getBoundingClientRect().bottom
  const t0 = now()
  // Where this loop left the scroller. Finding it somewhere else means someone
  // else owns the position now — the reader mid-flick, or the browser's own
  // overflow-anchor, which is already doing this loop's job. Either way the
  // compensation is over: writing on top of a fling is what kills the fling.
  let written: number | null = null
  const step = () => {
    if (cancelled) return
    if (written !== null && Math.abs(scroller.scrollTop - written) > 1) return
    const delta = anchorEl.getBoundingClientRect().bottom - bottom0
    if (Math.abs(delta) > 0.5) scroller.scrollTop += delta
    written = scroller.scrollTop
    if (now() - t0 < durationMs) raf(step)
  }
  raf(step)
  return () => {
    cancelled = true
  }
}
