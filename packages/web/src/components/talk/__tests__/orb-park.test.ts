import { describe, expect, it } from "vitest"
import {
  DEFAULT_PARK,
  PARK_STORAGE_KEY,
  nearestCorner,
  readPark,
  writePark,
  type OrbParkStore,
} from "../orb-park"

function fakeStore(initial?: string): OrbParkStore & { value: string | null } {
  return {
    value: initial ?? null,
    getItem(key: string) {
      return key === PARK_STORAGE_KEY ? this.value : null
    },
    setItem(key: string, value: string) {
      if (key === PARK_STORAGE_KEY) this.value = value
    },
  }
}

const VIEWPORT = { width: 1000, height: 800 }

describe("nearestCorner", () => {
  it("picks the corner of the quadrant the point sits in", () => {
    expect(nearestCorner({ x: 10, y: 10 }, VIEWPORT)).toBe("top-left")
    expect(nearestCorner({ x: 990, y: 10 }, VIEWPORT)).toBe("top-right")
    expect(nearestCorner({ x: 10, y: 790 }, VIEWPORT)).toBe("bottom-left")
    expect(nearestCorner({ x: 990, y: 790 }, VIEWPORT)).toBe("bottom-right")
  })

  it("resolves the exact centre to a single corner rather than wobbling", () => {
    expect(nearestCorner({ x: 500, y: 400 }, VIEWPORT)).toBe("bottom-right")
  })

  it("resolves points just either side of each midline", () => {
    expect(nearestCorner({ x: 499, y: 400 }, VIEWPORT)).toBe("bottom-left")
    expect(nearestCorner({ x: 500, y: 399 }, VIEWPORT)).toBe("top-right")
  })

  it("clamps out-of-bounds points to the corner they overshot", () => {
    expect(nearestCorner({ x: -400, y: -900 }, VIEWPORT)).toBe("top-left")
    expect(nearestCorner({ x: 9000, y: 9000 }, VIEWPORT)).toBe("bottom-right")
    expect(nearestCorner({ x: 9000, y: -900 }, VIEWPORT)).toBe("top-right")
    expect(nearestCorner({ x: -400, y: 9000 }, VIEWPORT)).toBe("bottom-left")
  })

  it("survives a zero-sized viewport", () => {
    expect(nearestCorner({ x: 0, y: 0 }, { width: 0, height: 0 })).toBe("bottom-right")
  })
})

describe("readPark / writePark", () => {
  it("round-trips every corner", () => {
    const store = fakeStore()
    for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"] as const) {
      writePark(corner, store)
      expect(readPark(store)).toBe(corner)
    }
  })

  it("writes under the documented key", () => {
    const store = fakeStore()
    writePark("top-left", store)
    expect(store.value).toBe("top-left")
  })

  it("falls back to the default corner when nothing is stored", () => {
    expect(readPark(fakeStore())).toBe(DEFAULT_PARK)
  })

  it("falls back to the default corner on malformed and unknown values", () => {
    expect(readPark(fakeStore(""))).toBe(DEFAULT_PARK)
    expect(readPark(fakeStore('{"corner":'))).toBe(DEFAULT_PARK)
    expect(readPark(fakeStore("middle-centre"))).toBe(DEFAULT_PARK)
    expect(readPark(fakeStore("BOTTOM-RIGHT"))).toBe(DEFAULT_PARK)
    expect(readPark(fakeStore("constructor"))).toBe(DEFAULT_PARK)
  })

  it("is a no-op without a store rather than throwing", () => {
    expect(readPark(null)).toBe(DEFAULT_PARK)
    expect(() => writePark("top-left", null)).not.toThrow()
  })
})
