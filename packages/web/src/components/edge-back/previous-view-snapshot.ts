import { useEffect, useState, type RefObject } from "react"
import { useLocation } from "react-router-dom"

/**
 * A copy of the view the shell was showing before the current one, so the back
 * gesture can reveal where it is going instead of dragging the screen off a
 * void.
 *
 * The copy is held at module scope rather than in a ref because React unmounts
 * the whole page tree between routes — including the shell that owns the
 * gesture — so anything kept inside it would be thrown away on the very
 * navigation the snapshot exists to cover. Exactly one tree is retained at a
 * time, and it is replaced on every navigation.
 */
let held: HTMLElement | null = null

/** Test-only: drop the retained view so a suite starts from a known state. */
export function clearPreviousViewSnapshot(): void {
  held = null
}

/** A photograph of a view that is no longer running: nothing in it can be
 *  focused, typed into, read out, or found twice by an id lookup. */
function photograph(source: HTMLElement): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement
  clone.removeAttribute("id")
  for (const element of clone.querySelectorAll("[id]")) element.removeAttribute("id")
  clone.setAttribute("aria-hidden", "true")
  clone.setAttribute("inert", "")
  clone.style.width = "100%"
  clone.style.height = "100%"
  return clone
}

/**
 * The previous view, or null when there is nothing behind this one — which is
 * also how the shell knows there is nowhere to swipe back to.
 *
 * Capture happens a frame after the navigation commits so the clone is of the
 * painted route rather than of the DOM mid-swap, and so the cost lands after
 * the new view is on screen rather than in front of it.
 */
export function usePreviousViewSnapshot(content: RefObject<HTMLElement | null>): HTMLElement | null {
  const { key } = useLocation()
  const [previous, setPrevious] = useState<HTMLElement | null>(null)

  useEffect(() => {
    setPrevious(held)
    held = null
    const frame = requestAnimationFrame(() => {
      if (content.current) held = photograph(content.current)
    })
    return () => cancelAnimationFrame(frame)
  }, [key, content])

  return previous
}
