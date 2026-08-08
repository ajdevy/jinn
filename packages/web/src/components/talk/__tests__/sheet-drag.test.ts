import { describe, expect, it } from "vitest"
import {
  DISMISS_DISTANCE,
  DISMISS_VELOCITY,
  STILL_MS,
  dragOutcome,
  rubberBand,
} from "../sheet-drag"

/** The common case: the finger was still moving in the frame it was lifted. */
const MOVING = 0

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
    expect(dragOutcome({ offsetY: DISMISS_DISTANCE - 1, velocityY: 0.05, idleMs: MOVING })).toBe("snap-back")
  })

  it("dismisses past the distance threshold, however slowly it was released", () => {
    expect(dragOutcome({ offsetY: DISMISS_DISTANCE, velocityY: 0, idleMs: MOVING })).toBe("dismiss")
    expect(dragOutcome({ offsetY: DISMISS_DISTANCE + 200, velocityY: 0, idleMs: MOVING })).toBe("dismiss")
  })

  it("dismisses a short flick past the velocity threshold", () => {
    expect(dragOutcome({ offsetY: 24, velocityY: DISMISS_VELOCITY, idleMs: MOVING })).toBe("dismiss")
  })

  it("never dismisses upward, however hard it is flicked", () => {
    expect(dragOutcome({ offsetY: -300, velocityY: -4, idleMs: MOVING })).toBe("snap-back")
    expect(dragOutcome({ offsetY: 0, velocityY: -4, idleMs: MOVING })).toBe("snap-back")
  })

  it("reads no flick from a drag that came to rest before it was let go", () => {
    const flick = { offsetY: 60, velocityY: DISMISS_VELOCITY * 2 }

    expect(dragOutcome({ ...flick, idleMs: STILL_MS })).toBe("dismiss")
    expect(dragOutcome({ ...flick, idleMs: STILL_MS + 1 })).toBe("snap-back")
  })

  it("still dismisses a rested drag that got there on distance alone", () => {
    expect(dragOutcome({ offsetY: DISMISS_DISTANCE, velocityY: 0, idleMs: 500 })).toBe("dismiss")
  })
})
