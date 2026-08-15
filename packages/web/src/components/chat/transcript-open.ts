import { useLayoutEffect, useRef, type MutableRefObject } from 'react'

/**
 * Opening a transcript.
 *
 * Two rules, and they are the whole module. **One target, decided before paint:**
 * where the reader left this transcript if they left a position, the bottom
 * otherwise. Never the bottom followed by a correction — that correction is the
 * jump the reader sees, because the browser has already painted the frame it
 * corrects.
 *
 * **The settle window holds the bottom, it does not travel to it.** A windowed
 * transcript enters at estimated row heights and re-measures as rows mount, so
 * the true bottom keeps moving down for a beat after the opening paint. Left
 * alone the reader drifts up off it, which is the open that needs a manual tap
 * on the down-arrow. Re-pinning through that beat holds their frame of reference
 * rather than moving it — but only while they are still pinned, only to the
 * bottom, and only until the content stops resizing or 400ms passes, whichever
 * is first. It is a stop condition, not a retry timer.
 */

/** The settle window closes here at the latest, measured from the opening write. */
export const SETTLE_WINDOW_MS = 400

interface OpenState {
  phase: 'waiting' | 'opening' | 'settling' | 'closed'
  openedAt: number
  size: number
}

export interface TranscriptOpenOptions {
  /** The scroll container, once it has mounted. */
  node: HTMLDivElement | null
  /** True once the transcript has content to open onto. */
  ready: boolean
  /** Where the reader left this transcript, when they left a position behind. */
  initialScrollTop?: number
  /** Puts the view at the true bottom. On a windowed transcript this goes through
   *  the virtualizer, which resolves it to the scroller's own clamped maximum —
   *  a `scrollTop = scrollHeight` write aims at the estimate and stops short. */
  scrollToBottom: (node: HTMLDivElement) => void
  /** Total content height as the transcript currently believes it. */
  contentSize: (node: HTMLDivElement) => number
  /** False once the reader owns the position. */
  isPinned: () => boolean
  /** Runs once, immediately after the opening write, with the position it made. */
  onOpened: (node: HTMLDivElement) => void
  /** Injectable for tests. */
  now?: () => number
}

export function useTranscriptOpen(options: TranscriptOpenOptions): void {
  const state = useRef<OpenState>({ phase: 'waiting', openedAt: 0, size: 0 })
  useOpeningWrite(state, options)
  useSettleWindow(state, options)
}

// Unkeyed on purpose: this has to run on the first commit where BOTH the scroller
// is attached and there is content, and which commit that is depends on the route
// the session took to get here.
function useOpeningWrite(state: MutableRefObject<OpenState>, options: TranscriptOpenOptions): void {
  const { node, ready, initialScrollTop, scrollToBottom, contentSize, onOpened, now = () => performance.now() } = options
  useLayoutEffect(() => {
    const open = state.current
    if (open.phase !== 'waiting' || !ready || !node) return
    if (initialScrollTop === undefined) scrollToBottom(node)
    else node.scrollTop = initialScrollTop
    open.phase = 'opening'
    open.openedAt = now()
    open.size = contentSize(node)
    onOpened(node)
  })
}

function useSettleWindow(state: MutableRefObject<OpenState>, options: TranscriptOpenOptions): void {
  const { node, scrollToBottom, contentSize, isPinned, now = () => performance.now() } = options
  useLayoutEffect(() => {
    const open = state.current
    if (!node) return
    // The opening commit runs this effect too, and its size reading is the one
    // just recorded — comparing them would close the window before it opened.
    if (open.phase === 'opening') {
      open.phase = 'settling'
      return
    }
    if (open.phase !== 'settling') return
    const size = contentSize(node)
    if (size === open.size || now() - open.openedAt >= SETTLE_WINDOW_MS) {
      open.phase = 'closed'
      return
    }
    open.size = size
    // Invariant S2: a reader who has taken the position owns it, and the settle
    // window does not weaken that by one frame.
    if (isPinned()) scrollToBottom(node)
  })
}
