import { useEffect, useState, type RefObject } from "react"
import { NavigationType, useLocation, useNavigationType } from "react-router-dom"

/**
 * Copies of the views the shell has shown, so the back gesture can reveal where
 * it is going instead of dragging the screen off a void.
 *
 * The copies are held at module scope rather than in a ref because React
 * unmounts the whole page tree between routes — including the shell that owns
 * the gesture — so anything kept inside it would be thrown away on the very
 * navigation the snapshot exists to cover.
 *
 * They are keyed by history entry rather than kept as a single "the last view",
 * because the last view is not always the next destination: after a back
 * navigation the view that was on screen a moment ago is the one *ahead* in
 * history, and revealing it would promise a destination `navigate(-1)` is not
 * going to reach. `entries` mirrors the browser's stack so the reveal and the
 * navigation always name the same view.
 */
const snapshots = new Map<string, HTMLElement>()
let entries: string[] = []
let cursor = 0
let counted: number | null = null

/** How many views stay photographed. A drag reveals exactly one step back and
 *  re-photographs each view as it is landed on, so only the entries just behind
 *  the cursor are ever read; retaining the whole session would hold a detached
 *  DOM tree for every route it ever visited. */
const RETAINED_VIEWS = 8

/** Test-only: forget every retained view so a suite starts from a known state. */
export function clearPreviousViewSnapshot(): void {
  snapshots.clear()
  entries = []
  cursor = 0
  counted = null
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
 * Reads the browser's own count of where it is in its history, and reports
 * whether it went up — which is what tells a brand new entry apart from a
 * rewrite of the one being stood on.
 *
 * React Router's navigation type is not enough on its own: a route that
 * redirects on arrival pushes and then replaces inside a single commit, so by
 * the time this runs the type reads REPLACE although the stack did grow. Memory
 * routing keeps no browser history at all, and there the type is all there is.
 */
function steppedForward(navigation: NavigationType): boolean {
  const idx = window.history.state?.idx
  const now = typeof idx === "number" ? idx : null
  const forward = now !== null && counted !== null ? now > counted : navigation !== NavigationType.Replace
  counted = now
  return forward
}

/**
 * Where the history now stands, as an index into the entries we have seen. A key
 * we already know is one that was popped back or forward to. A new key either
 * opens the next position — discarding whatever was ahead of it, exactly as the
 * browser does — or rewrites the current one, in which case the view standing
 * there keeps its photograph until a fresher one is taken a frame from now.
 */
function locate(key: string, navigation: NavigationType): number {
  const forward = steppedForward(navigation)
  const known = entries.indexOf(key)
  if (known >= 0) return known
  if (entries.length === 0) {
    entries = [key]
    return 0
  }

  const index = forward ? cursor + 1 : cursor
  const standing = forward ? undefined : snapshots.get(entries[index])
  for (const dropped of entries.splice(index)) snapshots.delete(dropped)
  entries[index] = key
  if (standing) snapshots.set(key, standing)
  return index
}

/** Drops the photographs the cursor has moved out of reach of. Entries ahead of
 *  it are dropped too: going forward lands on the live view, which is
 *  photographed again on arrival. */
function forgetDistantViews(): void {
  const reachable = new Set(entries.slice(Math.max(cursor - RETAINED_VIEWS + 1, 0), cursor + 1))
  for (const key of snapshots.keys()) if (!reachable.has(key)) snapshots.delete(key)
}

/**
 * The view `navigate(-1)` will land on, or null when there is nothing behind
 * this one — which is also how the shell knows there is nowhere to swipe back to.
 *
 * Capture happens a frame after the navigation commits so the clone is of the
 * painted route rather than of the DOM mid-swap, and so the cost lands after
 * the new view is on screen rather than in front of it.
 */
export function usePreviousViewSnapshot(content: RefObject<HTMLElement | null>): HTMLElement | null {
  const { key } = useLocation()
  const navigation = useNavigationType()
  const [previous, setPrevious] = useState<HTMLElement | null>(null)

  useEffect(() => {
    cursor = locate(key, navigation)
    forgetDistantViews()
    setPrevious(cursor > 0 ? snapshots.get(entries[cursor - 1]) ?? null : null)
    const frame = requestAnimationFrame(() => {
      if (content.current) snapshots.set(key, photograph(content.current))
    })
    return () => cancelAnimationFrame(frame)
  }, [key, navigation, content])

  return previous
}
