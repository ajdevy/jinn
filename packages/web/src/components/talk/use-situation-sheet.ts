import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import { CLOSE_MS, type SheetRect } from "./situation-choreography"
import type { Situation } from "./situation-payload"

/**
 * Everything the sheet does that is not markup: when it is on screen, when it
 * has been measured, and the modality — focus in, focus trapped, focus back.
 */

/** `measuring` is one invisible frame at final geometry, so the dock point the
 *  orb flies to is read from an untransformed box. */
export type SheetPhase = "measuring" | "entering" | "open" | "closing"

type LayoutSink = RefObject<((rect: SheetRect | null) => void) | undefined>

/** Two frames at 60Hz: long enough to have painted, short enough to feel instant. */
const ENTRANCE_BACKSTOP_MS = 32

function focusableWithin(node: HTMLElement): HTMLElement[] {
  return Array.from(
    node.querySelectorAll<HTMLElement>(
      [
        "button:not([disabled])",
        "[href]",
        "input:not([disabled])",
        "select:not([disabled])",
        "textarea:not([disabled])",
        '[tabindex]:not([tabindex="-1"])',
      ].join(","),
    ),
  ).filter((element) => element.getAttribute("aria-hidden") !== "true")
}

/** Tab and Shift+Tab wrap inside the panel, so focus never reaches the page. */
function cycleTab(panel: HTMLElement, event: KeyboardEvent): void {
  const focusable = focusableWithin(panel)
  if (focusable.length === 0) {
    event.preventDefault()
    panel.focus()
    return
  }
  // The panel itself holds focus from the moment it opens, and it sits ahead of
  // everything inside it — so backwards from there leads out of the sheet, the
  // same as backwards from the first card.
  const active = document.activeElement
  const atEdge = event.shiftKey
    ? active === focusable[0] || active === panel
    : active === focusable[focusable.length - 1]
  if (atEdge || !panel.contains(active)) {
    event.preventDefault()
    ;(event.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus()
  }
}

/** Deactivates the page behind the sheet, and puts it back exactly as it was. */
function usePageInert(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const page = document.getElementById("root")
    if (!page) return
    const priorInert = page.inert
    const priorHidden = page.getAttribute("aria-hidden")
    page.inert = true
    page.setAttribute("aria-hidden", "true")
    return () => {
      // `?? false` because a DOM without `inert` reflection reads it as undefined.
      page.inert = priorInert ?? false
      if (priorHidden === null) page.removeAttribute("aria-hidden")
      else page.setAttribute("aria-hidden", priorHidden)
    }
  }, [active])
}

/** Focus goes into the sheet on open and back to its origin when it leaves. */
function useFocusHandover(open: boolean, panelRef: RefObject<HTMLElement | null>): void {
  const returnToRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (open) {
      const active = document.activeElement
      if (active instanceof HTMLElement) returnToRef.current = active
      panelRef.current?.focus({ preventScroll: true })
      return
    }
    const target = returnToRef.current
    returnToRef.current = null
    if (target?.isConnected) target.focus({ preventScroll: true })
  }, [open, panelRef])
}

/**
 * `keyboardActive` is how the sheet stands down for a surface stacked over it:
 * the page stays deactivated and focus stays handed over, but Escape and Tab
 * belong to whatever is on top for as long as it is there.
 */
function useModality(
  active: boolean,
  keyboardActive: boolean,
  panelRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  usePageInert(active)
  useFocusHandover(active, panelRef)
  useEffect(() => {
    if (!active || !keyboardActive) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        onDismiss()
        return
      }
      if (event.key === "Tab" && panelRef.current) cycleTab(panelRef.current, event)
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [active, keyboardActive, panelRef, onDismiss])
}

/**
 * Settling is scheduled apart from the phase that triggers it: from inside that
 * effect, its own cleanup would cancel the callback the moment the phase landed.
 * A frame, so the browser paints the shrunken state and the transition has
 * somewhere to run from — plus a timer, because a backgrounded tab never fires
 * the frame and the sheet would sit there invisible forever.
 */
function useSettleTimer(entering: boolean, settle: () => void): void {
  useEffect(() => {
    if (!entering) return
    const frame = requestAnimationFrame(settle)
    const backstop = setTimeout(settle, ENTRANCE_BACKSTOP_MS)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(backstop)
    }
  }, [entering, settle])
}

/** The exit is released on the clock rather than on `transitionend`, which does
 *  not fire when the sheet is already offscreen or the tab is in the background. */
function useExitTimer(closing: boolean, finishExit: () => void): void {
  useEffect(() => {
    if (!closing) return
    const timer = setTimeout(finishExit, CLOSE_MS)
    return () => clearTimeout(timer)
  }, [closing, finishExit])
}

/**
 * The sheet is measured once on the way in, and a rotation or a resized window
 * moves it afterwards — full-width bottom sheet at one breakpoint, a panel with
 * a shoulder at the other. The orb docks to that box, so a stale one leaves it
 * flying to where the sheet used to be, which on a phone is over the sheet's own
 * controls. Only while settled: the entrance is transformed, and measuring it
 * mid-scale would hand out a box the sheet never occupies.
 */
function useMeasuredOnResize(
  settled: boolean,
  panelRef: RefObject<HTMLElement | null>,
  layoutRef: LayoutSink,
): void {
  useEffect(() => {
    if (!settled) return
    const remeasure = () => {
      const box = panelRef.current?.getBoundingClientRect()
      if (box) layoutRef.current?.({ left: box.left, top: box.top, width: box.width, height: box.height })
    }
    window.addEventListener("resize", remeasure)
    return () => window.removeEventListener("resize", remeasure)
  }, [settled, panelRef, layoutRef])
}

/**
 * Keeps the situation on screen through its exit, and walks it from the frame it
 * is measured in to the frame it is settled in.
 */
function useRetainedSituation(
  situation: Situation | null,
  reduce: boolean,
  panelRef: RefObject<HTMLElement | null>,
  layoutRef: LayoutSink,
): { shown: Situation | null; phase: SheetPhase } {
  const [shown, setShown] = useState<Situation | null>(situation)
  const [phase, setPhase] = useState<SheetPhase>("measuring")
  // Read through a ref so `shown` can be consulted without reopening on it.
  const shownRef = useRef(shown)
  shownRef.current = shown

  const settle = useCallback(() => setPhase("open"), [])

  const finishExit = useCallback(() => {
    setShown(null)
    layoutRef.current?.(null)
  }, [layoutRef])

  useLayoutEffect(() => {
    if (situation) {
      setShown(situation)
      setPhase("measuring")
      return
    }
    if (!shownRef.current) return
    setPhase("closing")
    if (reduce) finishExit()
  }, [situation, reduce, finishExit])

  // One invisible frame at final geometry: measure, hand the box to the orb, then
  // either resolve immediately or shrink under it and grow back. `shown` is a
  // dependency because the panel only exists from the render after it is set.
  useLayoutEffect(() => {
    if (phase !== "measuring" || !panelRef.current) return
    const box = panelRef.current.getBoundingClientRect()
    layoutRef.current?.({ left: box.left, top: box.top, width: box.width, height: box.height })
    if (reduce) {
      setPhase("open")
      return
    }
    setPhase("entering")
  }, [shown, phase, reduce, panelRef, layoutRef])

  useSettleTimer(phase === "entering", settle)
  useExitTimer(phase === "closing" && !reduce, finishExit)
  useMeasuredOnResize(phase === "open", panelRef, layoutRef)

  return { shown, phase }
}

interface SheetState {
  /** The situation on screen, retained through the exit. */
  shown: Situation | null
  phase: SheetPhase
  panelRef: RefObject<HTMLElement | null>
}

export function useSituationSheet(
  situation: Situation | null,
  reduce: boolean,
  keyboardActive: boolean,
  onDismiss: () => void,
  onLayout?: (rect: SheetRect | null) => void,
): SheetState {
  const panelRef = useRef<HTMLElement | null>(null)
  // Held in a ref so a caller's inline callback cannot restart the entrance.
  const layoutRef = useRef(onLayout)
  layoutRef.current = onLayout

  const { shown, phase } = useRetainedSituation(situation, reduce, panelRef, layoutRef)
  useModality(shown !== null, keyboardActive, panelRef, onDismiss)

  return { shown, phase, panelRef }
}
