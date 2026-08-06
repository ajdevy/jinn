import { describe, expect, it } from "vitest"
import { ORB_STATES, lobeCentres, orbParams, type OrbState } from "../orb-motion"

/** The four dimensions a viewer reads off the sphere without any label. */
function signature(state: OrbState) {
  const { radius, softness, brightness, rotationSign } = orbParams(state)
  return { radius, softness, brightness, rotationSign }
}

describe("orbParams", () => {
  it("gives every state a distinct signature", () => {
    for (const a of ORB_STATES) {
      for (const b of ORB_STATES) {
        if (a === b) continue
        expect(signature(a), `${a} vs ${b}`).not.toEqual(signature(b))
      }
    }
  })

  it("separates the states on radius, softness and brightness individually", () => {
    for (const key of ["radius", "softness", "brightness"] as const) {
      const values = ORB_STATES.map((state) => signature(state)[key])
      expect(new Set(values).size).toBe(ORB_STATES.length)
    }
  })

  it("counter-rotates only while thinking", () => {
    expect(orbParams("thinking").rotationSign).toBe(-1)
    for (const state of ORB_STATES.filter((s) => s !== "thinking")) {
      expect(orbParams(state).rotationSign).toBe(1)
    }
  })

  it("keeps lobe softness under the merge threshold in every state", () => {
    for (const state of ORB_STATES) {
      expect(orbParams(state).softness).toBeLessThanOrEqual(0.09)
    }
  })

  it("pushes the listening lobes outward and brighter as amplitude rises", () => {
    const quiet = orbParams("listening", 0)
    const loud = orbParams("listening", 1)
    expect(loud.radius).toBeGreaterThan(quiet.radius)
    expect(loud.orbit).toBeGreaterThan(quiet.orbit)
    expect(loud.brightness).toBeGreaterThan(quiet.brightness)
  })

  it("rides brightness on the output envelope while speaking", () => {
    expect(orbParams("speaking", 1).brightness).toBeGreaterThan(orbParams("speaking", 0).brightness)
  })

  it("ignores amplitude in the states nothing is driving", () => {
    expect(orbParams("idle", 1)).toEqual(orbParams("idle", 0))
    expect(orbParams("thinking", 1)).toEqual(orbParams("thinking", 0))
  })

  it("clamps amplitude out of range instead of exploding the sphere", () => {
    expect(orbParams("speaking", 4)).toEqual(orbParams("speaking", 1))
    expect(orbParams("speaking", -2)).toEqual(orbParams("speaking", 0))
    expect(orbParams("speaking", Number.NaN)).toEqual(orbParams("speaking", 0))
  })
})

describe("lobeCentres", () => {
  it("returns three lobes inside the sphere", () => {
    for (const state of ORB_STATES) {
      const lobes = lobeCentres(orbParams(state), 3.7)
      expect(lobes).toHaveLength(3)
      for (const lobe of lobes) {
        expect(Math.hypot(lobe.x, lobe.y) + lobe.radius).toBeLessThanOrEqual(1)
      }
    }
  })

  it("drifts the lobes over time", () => {
    const params = orbParams("idle")
    expect(lobeCentres(params, 2)).not.toEqual(lobeCentres(params, 0))
  })

  it("mirrors the drift direction when the rotation sign flips", () => {
    const forward = orbParams("idle")
    const reversed = { ...forward, rotationSign: -1 as const }
    const [a] = lobeCentres(forward, 1)
    const [b] = lobeCentres(reversed, 1)
    expect(a.x).toBeCloseTo(b.x, 10)
    expect(a.y).toBeCloseTo(-b.y, 10)
  })

  it("gives the three lobes different sizes so they read as cloud, not as a disc", () => {
    const radii = lobeCentres(orbParams("idle"), 0).map((lobe) => lobe.radius)
    expect(new Set(radii).size).toBe(3)
  })
})
