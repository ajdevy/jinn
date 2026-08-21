import { useEffect, useMemo, useRef } from 'react'

/** The entrance (--duration-base) plus a paint. The mark belongs to the commit
 *  that swaps the title, not to the title, so it is dropped again afterwards. */
const ENTER_MARK_TTL_MS = 1_000

/** Read live on the commit that would mark, like the transcript's arrivals: a
 *  setting changed mid-session takes effect on the next title, no listener. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/**
 * True on the commit that replaces one conversation title with another.
 *
 * The title a header mounts with is never marked — it did not arrive, it was
 * already there — so returning to a thread cannot replay an entrance the reader
 * has watched, and an unrelated rerender animates nothing.
 */
export function useTitleArrival(title: string): boolean {
  const seenRef = useRef<string | null>(null)
  const enteringRef = useRef(false)

  // Mutated during render, deliberately: the mark has to reach the very commit
  // that paints the new title, or the entrance it describes is already over.
  useMemo(() => {
    const seen = seenRef.current
    if (seen === null || seen === title) return
    seenRef.current = title
    if (prefersReducedMotion()) return
    enteringRef.current = true
    setTimeout(() => { enteringRef.current = false }, ENTER_MARK_TTL_MS)
  }, [title])

  useEffect(() => {
    if (seenRef.current === null) seenRef.current = title
  }, [title])

  return enteringRef.current
}
