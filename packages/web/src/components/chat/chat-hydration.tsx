import { useEffect, useState } from 'react'

// Loading is a threshold, not a default: a transcript that arrives inside this
// window should never have announced itself at all.
const SPINNER_DELAY_MS = 250

/** True once a pending load has run long enough to be worth showing. */
export function useHydrationSpinner(pending: boolean): boolean {
  const [elapsed, setElapsed] = useState(false)
  useEffect(() => {
    if (!pending) {
      setElapsed(false)
      return
    }
    const timer = window.setTimeout(() => setElapsed(true), SPINNER_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [pending])
  return pending && elapsed
}

/**
 * Sits over the transcript instead of replacing it — unmounting the transcript
 * to show a spinner is what blanked the chat on the first message.
 *
 * The z-index is load-bearing: the transcript is a later, positioned, opaque
 * sibling, so at `z-index: auto` it paints over this and the spinner is
 * invisible even though it is in the tree. Stays under the drop-zone overlay.
 */
export function ChatHydrationOverlay() {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
      role="status"
      aria-label="Loading chat"
    >
      <div className="size-5 animate-spin rounded-full border-2 border-[var(--fill-tertiary)] border-t-[var(--accent)]" />
    </div>
  )
}
