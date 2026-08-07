/**
 * The gesture arithmetic behind throwing a sheet away: how far it moves under
 * the finger, and whether letting go dismisses it. Pure and DOM-free, so the
 * feel is held by a test rather than by eye — and so the sheet and the media
 * preview drag on exactly the same numbers instead of each keeping their own.
 */

/** Past this, letting go dismisses however slowly the finger was moving. */
export const DISMISS_DISTANCE = 96

/** px per ms. A flick this fast dismisses without covering the distance. */
export const DISMISS_VELOCITY = 0.5

/**
 * How long a finger may rest before the speed it arrived at stops describing it.
 * A surface held still and then let go was put down, not thrown, however fast it
 * was moving on the way.
 */
export const STILL_MS = 100

/** How much of the drag survives once it is past the point of no return. */
const RESISTANCE = 0.35

export interface DragRelease {
  /** How far the finger has travelled from where it went down. Down is positive. */
  offsetY: number
  /** Its speed at release, in px per ms. Down is positive. */
  velocityY: number
  /** How long ago that speed was measured. */
  idleMs: number
}

export type DragOutcome = "dismiss" | "snap-back"

/**
 * The sheet tracks the finger exactly while it is still recoverable, then goes
 * heavy — so the operator feels the threshold rather than reading about it.
 * Upward is damped from the first pixel: the sheet is already at rest against
 * the top of its travel and there is nothing above it to reach.
 */
export function rubberBand(offsetY: number): number {
  if (offsetY <= 0) return offsetY * RESISTANCE
  if (offsetY <= DISMISS_DISTANCE) return offsetY
  return DISMISS_DISTANCE + (offsetY - DISMISS_DISTANCE) * RESISTANCE
}

/**
 * What releasing here means. Distance decides first; speed is the shortcut, and
 * only speed the finger still had — a sample it has since sat on describes where
 * the drag has been, not what letting go of it means.
 */
export function dragOutcome({ offsetY, velocityY, idleMs }: DragRelease): DragOutcome {
  if (offsetY <= 0) return "snap-back"
  if (offsetY >= DISMISS_DISTANCE) return "dismiss"
  if (idleMs > STILL_MS) return "snap-back"
  return velocityY >= DISMISS_VELOCITY ? "dismiss" : "snap-back"
}
