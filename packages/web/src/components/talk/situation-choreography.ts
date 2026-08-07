import type { ParkCorner, Point, Viewport } from "./orb-park"

/**
 * Where the orb flies when a situation opens, and how long the flight takes.
 * Pure, so the arc can be held by a test rather than by eye — and so the sheet
 * and the orb read the same numbers instead of each keeping their own copy.
 */

/** Park to sheet edge. */
export const OPEN_MS = 280
/** Sheet edge back home. Shorter, because a dismissal should not linger. */
export const CLOSE_MS = 240

/** One curve for the whole choreography: sheet scale, opacity, and the orb's flight. */
export const DOCK_EASE = "var(--ease-snappy)"

/** The sphere's diameter, matching the orb widget. */
export const ORB_SIZE = 64

/** Breathing room between the orb's rim and the sheet's edge. */
export const ORB_EDGE_GAP = 12

/**
 * The right-hand lane the mobile header keeps clear. The orb overlaps the sheet
 * on a phone — there is no room beside it — so the title has to stop short of
 * the docked sphere rather than run under it.
 */
export const MOBILE_TITLE_GUTTER = ORB_SIZE + ORB_EDGE_GAP * 2

/** Tailwind's `lg`, where the sheet stops being a full-width bottom sheet. */
const DESKTOP_MIN_WIDTH = 1024

export type Breakpoint = "desktop" | "mobile"

/** The sheet's box in viewport coordinates. A DOMRect satisfies this. */
export interface SheetRect {
  left: number
  top: number
  width: number
  height: number
}

export interface DockPath {
  from: Point
  to: Point
  durationMs: number
  ease: string
}

export function breakpointOf(viewport: Viewport): Breakpoint {
  return viewport.width >= DESKTOP_MIN_WIDTH ? "desktop" : "mobile"
}

function clampX(x: number, viewport: Viewport): number {
  const radius = ORB_SIZE / 2
  return Math.min(Math.max(x, radius), viewport.width - radius)
}

/**
 * The centre the orb flies to. On desktop it sits just outside the sheet's near
 * edge — the side it was parked on, so the sheet rises next to the orb instead
 * of dragging it across the screen — at the sheet's vertical centre. A phone has
 * no room beside a full-width sheet, so the orb straddles the top edge on the
 * right, inside the gutter the header reserves for it.
 */
export function dockPoint(
  corner: ParkCorner,
  sheet: SheetRect,
  viewport: Viewport,
  breakpoint: Breakpoint,
): Point {
  const right = sheet.left + sheet.width
  if (breakpoint === "mobile") {
    return { x: clampX(right - ORB_EDGE_GAP - ORB_SIZE / 2, viewport), y: sheet.top }
  }
  const parkedLeft = corner === "top-left" || corner === "bottom-left"
  const beside = parkedLeft
    ? sheet.left - ORB_EDGE_GAP - ORB_SIZE / 2
    : right + ORB_EDGE_GAP + ORB_SIZE / 2
  return { x: clampX(beside, viewport), y: sheet.top + sheet.height / 2 }
}

/** The same two points either way round, so closing retraces opening. */
export function dockPath(phase: "open" | "close", park: Point, dock: Point): DockPath {
  return phase === "open"
    ? { from: park, to: dock, durationMs: OPEN_MS, ease: DOCK_EASE }
    : { from: dock, to: park, durationMs: CLOSE_MS, ease: DOCK_EASE }
}
