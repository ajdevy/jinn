import { describe, expect, it } from "vitest"
import {
  CLOSE_MS,
  DOCK_EASE,
  MOBILE_TITLE_GUTTER,
  OPEN_MS,
  ORB_SIZE,
  breakpointOf,
  dockPath,
  dockPoint,
  type SheetRect,
} from "../situation-choreography"
import type { ParkCorner } from "../orb-park"

const CORNERS: ParkCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"]

/** A desktop sheet: 816 wide, bottom-anchored and horizontally centred in 1440x900. */
const DESKTOP_SHEET: SheetRect = { left: 312, top: 520, width: 816, height: 360 }
const DESKTOP_VIEWPORT = { width: 1440, height: 900 }

/** A mobile sheet: full width, bottom-anchored in 390x844. */
const MOBILE_SHEET: SheetRect = { left: 0, top: 460, width: 390, height: 384 }
const MOBILE_VIEWPORT = { width: 390, height: 844 }

describe("breakpointOf", () => {
  it("reads 390px as mobile and 1440px as desktop", () => {
    expect(breakpointOf(MOBILE_VIEWPORT)).toBe("mobile")
    expect(breakpointOf(DESKTOP_VIEWPORT)).toBe("desktop")
  })

  it("switches at the lg breakpoint, not below it", () => {
    expect(breakpointOf({ width: 1023, height: 800 })).toBe("mobile")
    expect(breakpointOf({ width: 1024, height: 800 })).toBe("desktop")
  })
})

describe("dockPoint", () => {
  it("docks to the sheet's right edge at its vertical centre on desktop", () => {
    for (const corner of ["top-right", "bottom-right"] as ParkCorner[]) {
      const dock = dockPoint(corner, DESKTOP_SHEET, DESKTOP_VIEWPORT, "desktop")
      expect(dock.y).toBe(DESKTOP_SHEET.top + DESKTOP_SHEET.height / 2)
      expect(dock.x).toBeGreaterThan(DESKTOP_SHEET.left + DESKTOP_SHEET.width)
    }
  })

  it("mirrors to the sheet's left edge when the orb is parked on the left", () => {
    for (const corner of ["top-left", "bottom-left"] as ParkCorner[]) {
      const dock = dockPoint(corner, DESKTOP_SHEET, DESKTOP_VIEWPORT, "desktop")
      expect(dock.y).toBe(DESKTOP_SHEET.top + DESKTOP_SHEET.height / 2)
      expect(dock.x).toBeLessThan(DESKTOP_SHEET.left)
    }
  })

  it("keeps the docked orb fully on screen on desktop, from every corner", () => {
    for (const corner of CORNERS) {
      const dock = dockPoint(corner, DESKTOP_SHEET, DESKTOP_VIEWPORT, "desktop")
      expect(dock.x - ORB_SIZE / 2).toBeGreaterThanOrEqual(0)
      expect(dock.x + ORB_SIZE / 2).toBeLessThanOrEqual(DESKTOP_VIEWPORT.width)
    }
  })

  it("docks to the sheet's top edge on the right on mobile, from every corner", () => {
    for (const corner of CORNERS) {
      const dock = dockPoint(corner, MOBILE_SHEET, MOBILE_VIEWPORT, "mobile")
      expect(dock.y).toBe(MOBILE_SHEET.top)
      expect(dock.x).toBeGreaterThan(MOBILE_SHEET.left + MOBILE_SHEET.width / 2)
      expect(dock.x + ORB_SIZE / 2).toBeLessThanOrEqual(MOBILE_VIEWPORT.width)
    }
  })

  it("clears the title at 390px: the orb stays inside the header's reserved gutter", () => {
    const sheetRight = MOBILE_SHEET.left + MOBILE_SHEET.width
    for (const corner of CORNERS) {
      const dock = dockPoint(corner, MOBILE_SHEET, MOBILE_VIEWPORT, "mobile")
      expect(dock.x - ORB_SIZE / 2).toBeGreaterThanOrEqual(sheetRight - MOBILE_TITLE_GUTTER)
    }
  })
})

describe("dockPath", () => {
  const park = { x: 1360, y: 820 }
  const dock = dockPoint("bottom-right", DESKTOP_SHEET, DESKTOP_VIEWPORT, "desktop")

  it("opens in 280ms and closes in 240ms on one easing", () => {
    expect(OPEN_MS).toBe(280)
    expect(CLOSE_MS).toBe(240)
    expect(dockPath("open", park, dock).durationMs).toBe(280)
    expect(dockPath("close", park, dock).durationMs).toBe(240)
    expect(dockPath("open", park, dock).ease).toBe(DOCK_EASE)
    expect(dockPath("close", park, dock).ease).toBe(DOCK_EASE)
  })

  it("closes along the open path reversed", () => {
    const open = dockPath("open", park, dock)
    const close = dockPath("close", park, dock)
    expect(open.from).toEqual(close.to)
    expect(open.to).toEqual(close.from)
  })
})
