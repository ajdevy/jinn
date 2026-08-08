/**
 * The arithmetic behind zooming and panning a picture: how far a gesture may
 * zoom, and where the picture has to sit so the spot under the fingers stays
 * under the fingers. Pure, so every viewer that offers the gesture reads the
 * same numbers rather than keeping its own copy of them.
 */

export interface Point {
  x: number
  y: number
}

/** Fit to frame. Nothing zooms out past the box it was given. */
export const MIN_ZOOM = 1

/** Close enough to read a label in a screenshot, near enough to stay sharp. */
export const MAX_ZOOM = 4

export function pointDistance(first: Point, second: Point): number {
  return Math.hypot(second.x - first.x, second.y - first.y)
}

export function midpoint(first: Point, second: Point): Point {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/**
 * The pan that keeps the spot the gesture started on pinned under where the
 * gesture is now, across a change of zoom. Back at fit, there is nowhere left to
 * pan to, so the picture returns to centre rather than sitting off its frame.
 */
export function panAroundPoint({
  startPan,
  startZoom,
  nextZoom,
  startPoint,
  nextPoint,
  imageCenter,
}: {
  startPan: Point
  startZoom: number
  nextZoom: number
  startPoint: Point
  nextPoint: Point
  imageCenter: Point
}): Point {
  if (nextZoom === MIN_ZOOM) return { x: 0, y: 0 }
  const ratio = nextZoom / startZoom
  return {
    x: nextPoint.x - imageCenter.x - (startPoint.x - imageCenter.x - startPan.x) * ratio,
    y: nextPoint.y - imageCenter.y - (startPoint.y - imageCenter.y - startPan.y) * ratio,
  }
}
