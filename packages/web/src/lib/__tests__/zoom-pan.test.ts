import { describe, expect, it } from "vitest"
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
  midpoint,
  panAroundPoint,
  pointDistance,
} from "../zoom-pan"

const CENTRE = { x: 100, y: 100 }
const NO_PAN = { x: 0, y: 0 }

describe("clampZoom", () => {
  it("holds a gesture inside the range it is allowed to reach", () => {
    expect(clampZoom(2)).toBe(2)
    expect(clampZoom(0.2)).toBe(MIN_ZOOM)
    expect(clampZoom(40)).toBe(MAX_ZOOM)
  })
})

describe("pointDistance and midpoint", () => {
  it("measures a pinch by the gap between the two fingers", () => {
    expect(pointDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
  })

  it("puts the pinch's anchor halfway between them", () => {
    expect(midpoint({ x: 0, y: 10 }, { x: 20, y: 30 })).toEqual({ x: 10, y: 20 })
  })
})

describe("panAroundPoint", () => {
  it("keeps the spot under the fingers under the fingers as the zoom grows", () => {
    // A point 50px right of centre, zoomed 2x, has to move 50px further right
    // to stay under the finger that did not move.
    const pan = panAroundPoint({
      startPan: NO_PAN,
      startZoom: 1,
      nextZoom: 2,
      startPoint: { x: 150, y: 100 },
      nextPoint: { x: 150, y: 100 },
      imageCenter: CENTRE,
    })

    expect(pan).toEqual({ x: -50, y: 0 })
  })

  it("follows the fingers when they travel as well as spread", () => {
    const pan = panAroundPoint({
      startPan: NO_PAN,
      startZoom: 2,
      nextZoom: 2,
      startPoint: { x: 100, y: 100 },
      nextPoint: { x: 130, y: 120 },
      imageCenter: CENTRE,
    })

    expect(pan).toEqual({ x: 30, y: 20 })
  })

  it("recentres at fit, where there is nowhere left to pan to", () => {
    expect(
      panAroundPoint({
        startPan: { x: 80, y: 40 },
        startZoom: 3,
        nextZoom: MIN_ZOOM,
        startPoint: { x: 150, y: 100 },
        nextPoint: { x: 10, y: 10 },
        imageCenter: CENTRE,
      }),
    ).toEqual(NO_PAN)
  })
})
