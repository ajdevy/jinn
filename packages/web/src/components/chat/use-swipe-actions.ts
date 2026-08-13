import { useCallback, useEffect, useRef, useState } from "react"
import { EDGE_GUTTER_PX } from "../edge-back/use-edge-back-gesture"

export type SwipeSide = "leading" | "trailing"

export interface SwipeRails {
  /** Width revealed by dragging right, in px. 0 = no leading rail. */
  leading: number
  /** Width revealed by dragging left, in px. 0 = no trailing rail. */
  trailing: number
}

export interface SwipeState {
  /** Translation of the row content. Negative reveals the trailing rail. */
  offset: number
  openSide: SwipeSide | null
  /** null until the gesture has travelled far enough to commit to an axis. */
  axis: "horizontal" | "vertical" | null
  /** Where the finger went down, plus the offset it started from. null = no gesture. */
  origin: { x: number; y: number; offset: number } | null
}

export type SwipeEvent =
  | { kind: "down"; x: number; y: number }
  | { kind: "move"; x: number; y: number }
  | { kind: "release" }
  | { kind: "close" }

export const CLOSED_SWIPE: SwipeState = { offset: 0, openSide: null, axis: null, origin: null }

/** How far the finger travels before the gesture decides it is a swipe or a scroll.
 *  Below this the row must not move at all, or every scroll starts by nudging rows. */
export const AXIS_LOCK_PX = 8

/** Fraction of the rail that has to be dragged for the release to open it. */
export const COMMIT_RATIO = 0.4

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

/** Which way the gesture is going, or null while it is still too small to tell.
 *  A vertical lock is final for the rest of the gesture: a row that starts
 *  sliding halfway through a scroll is exactly what makes a web list feel unlike
 *  a native one. */
function lockAxis(dx: number, dy: number): SwipeState["axis"] {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_LOCK_PX) return null
  return Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical"
}

function track(state: SwipeState, x: number, y: number, rails: SwipeRails): SwipeState {
  const { origin } = state
  if (!origin) return state
  const axis = state.axis ?? lockAxis(x - origin.x, y - origin.y)
  if (axis !== "horizontal") return axis === state.axis ? state : { ...state, axis }
  return { ...state, axis, offset: clamp(origin.offset + (x - origin.x), -rails.trailing, rails.leading) }
}

/** Where the row lands when the finger lifts: fully open if the drag cleared the
 *  commit threshold, fully closed otherwise. Never halfway. */
function settle(state: SwipeState, rails: SwipeRails): SwipeState {
  const settled = { ...state, axis: null, origin: null }
  if (state.axis !== "horizontal") return settled
  if (rails.trailing > 0 && state.offset <= -rails.trailing * COMMIT_RATIO) {
    return { ...settled, offset: -rails.trailing, openSide: "trailing" }
  }
  if (rails.leading > 0 && state.offset >= rails.leading * COMMIT_RATIO) {
    return { ...settled, offset: rails.leading, openSide: "leading" }
  }
  return { ...settled, offset: 0, openSide: null }
}

/** The whole gesture, as a pure transition — so the thresholds are testable
 *  without a browser, a pointer, or a rendered row. */
export function reduceSwipe(state: SwipeState, event: SwipeEvent, rails: SwipeRails): SwipeState {
  switch (event.kind) {
    case "down":
      // A touch landing in the shell's edge gutter is the back gesture starting,
      // not this row: one finger cannot mean two horizontal drags at once.
      if (event.x <= EDGE_GUTTER_PX) return state
      return { ...state, axis: null, origin: { x: event.x, y: event.y, offset: state.offset } }
    case "move":
      return track(state, event.x, event.y, rails)
    case "release":
      return settle(state, rails)
    case "close":
      return CLOSED_SWIPE
  }
}

/** Moves and releases are read off the window rather than the row, so a finger
 *  that slides past the row's edge still finishes its gesture. */
function useWindowPointer(active: boolean, dispatch: (event: SwipeEvent) => void) {
  useEffect(() => {
    if (!active) return
    const onMove = (event: PointerEvent) => dispatch({ kind: "move", x: event.clientX, y: event.clientY })
    const onRelease = () => dispatch({ kind: "release" })
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onRelease)
    window.addEventListener("pointercancel", onRelease)
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onRelease)
      window.removeEventListener("pointercancel", onRelease)
    }
  }, [active, dispatch])
}

/** Drag state for one row. */
export function useSwipeActions(rails: SwipeRails) {
  const [state, setState] = useState<SwipeState>(CLOSED_SWIPE)
  const railsRef = useRef(rails)
  railsRef.current = rails

  // Releasing a drag still produces a click on whatever sat under the finger, so
  // without this the row would open the chat — or shut the rail it just opened —
  // the instant the swipe finished.
  const dragged = useRef(false)
  // The gesture is reduced against a ref, not the rendered state: a move and the
  // release that follows it can land in the same React batch, and reading the
  // committed state would then miss the drag entirely.
  const latest = useRef(state)
  const dispatch = useCallback((event: SwipeEvent) => {
    if (latest.current.axis === "horizontal") dragged.current = true
    latest.current = reduceSwipe(latest.current, event, railsRef.current)
    setState(latest.current)
  }, [])

  useWindowPointer(state.origin !== null, dispatch)

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => dispatch({ kind: "down", x: event.clientX, y: event.clientY }),
    [dispatch],
  )
  const close = useCallback(() => dispatch({ kind: "close" }), [dispatch])

  const onClickCapture = useCallback((event: React.MouseEvent) => {
    if (!dragged.current) return
    dragged.current = false
    event.preventDefault()
    event.stopPropagation()
  }, [])

  return {
    offset: state.offset,
    openSide: state.openSide,
    dragging: state.axis === "horizontal",
    /** Finger is down and has not turned into a drag — the row's pressed state.
     *  It lands on pointer-down, well before any click, and lets go as soon as
     *  the touch commits to an axis or lifts. */
    pressing: state.origin !== null && state.axis === null,
    onPointerDown,
    onClickCapture,
    close,
  }
}
