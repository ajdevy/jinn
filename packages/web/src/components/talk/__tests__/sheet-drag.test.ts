import { describe, expect, it } from "vitest"
import {
  DISMISS_DISTANCE,
  DISMISS_VELOCITY,
  dragOutcome,
  rubberBand,
} from "../sheet-drag"

describe("rubberBand", () => {
  it("follows the finger 1:1 while the sheet is still recoverable", () => {
    expect(rubberBand(0)).toBe(0)
    expect(rubberBand(40)).toBe(40)
    expect(rubberBand(DISMISS_DISTANCE)).toBe(DISMISS_DISTANCE)
  })

  it("resists past the threshold without ever running away from the finger", () => {
    const near = rubberBand(DISMISS_DISTANCE + 100)
    const far = rubberBand(DISMISS_DISTANCE + 300)

    expect(near).toBeGreaterThan(DISMISS_DISTANCE)
    expect(near).toBeLessThan(DISMISS_DISTANCE + 100)
    expect(far).toBeGreaterThan(near)
    expect(far).toBeLessThan(DISMISS_DISTANCE + 300)
  })

  it("damps an upward drag from the first pixel: there is nothing above the sheet", () => {
    expect(rubberBand(-100)).toBeLessThan(0)
    expect(rubberBand(-100)).toBeGreaterThan(-100)
  })
})

describe("dragOutcome", () => {
  it("snaps back a short, slow drag", () => {
    expect(dragOutcome({ offsetY: DISMISS_DISTANCE - 1, velocityY: 0.05 })).toBe("snap-back")
  })

  it("dismisses past the distance threshold, however slowly it was released", () => {
    expect(dragOutcome({ offsetY: DISMISS_DISTANCE, velocityY: 0 })).toBe("dismiss")
    expect(dragOutcome({ offsetY: DISMISS_DISTANCE + 200, velocityY: 0 })).toBe("dismiss")
  })

  it("dismisses a short flick past the velocity threshold", () => {
    expect(dragOutcome({ offsetY: 24, velocityY: DISMISS_VELOCITY })).toBe("dismiss")
  })

  it("never dismisses upward, however hard it is flicked", () => {
    expect(dragOutcome({ offsetY: -300, velocityY: -4 })).toBe("snap-back")
    expect(dragOutcome({ offsetY: 0, velocityY: -4 })).toBe("snap-back")
  })
})
