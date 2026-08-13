import { useCallback, useLayoutEffect, useRef, type RefObject } from "react"
import { captureVisibleAnchor, restoreVisibleAnchor, type ScrollAnchor } from "@/lib/scroll-anchor"

/** Attribute a row carries so the reader's position can be measured against it. */
export const ANCHOR_ATTRIBUTE = "data-anchor-id"

/**
 * Hold the reader's place in a scroll container across every re-render.
 *
 * Any reflow above the read position moves what the reader is looking at: a
 * status change re-sorting a Todo into another group, the optimistic patch, the
 * refetch that follows it. This restores the anchored row to the offset it had
 * before the commit, then re-anchors for the next one.
 *
 * The caller must wire the returned handler to the container's `onScroll`.
 * Without it a reader who scrolls between two commits is corrected back to
 * where they were, which is the same jump seen from the other side.
 */
export function useScrollAnchor(
  ref: RefObject<HTMLElement | null>,
  enabled = true,
  attribute = ANCHOR_ATTRIBUTE,
): () => void {
  const anchorRef = useRef<ScrollAnchor | null>(null)

  // No dependency array on purpose: any commit can be the one that changed a
  // height above the reader, so every commit restores against the snapshot from
  // the previous one and then takes a fresh snapshot.
  useLayoutEffect(() => {
    const node = ref.current
    if (!node || !enabled) {
      anchorRef.current = null
      return
    }
    // At the very top there is nothing above the reader to correct for, and a
    // snapshot taken before a programmatic scroll — the POP restore writes one
    // on mount — would otherwise drag the container back to where it started.
    const previous = anchorRef.current
    if (previous && previous.scrollTop > 0) restoreVisibleAnchor(node, previous)
    anchorRef.current = captureVisibleAnchor(node, attribute)
  })

  return useCallback(() => {
    const node = ref.current
    if (node && enabled) anchorRef.current = captureVisibleAnchor(node, attribute)
  }, [ref, enabled, attribute])
}
