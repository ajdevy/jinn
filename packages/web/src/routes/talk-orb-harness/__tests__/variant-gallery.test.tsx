import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import TalkOrbHarnessPage from "../page"

const VARIANTS = ["mist", "coin", "ring", "pulse"] as const
const STATES = ["idle", "listening", "thinking", "speaking", "interrupted", "error"] as const

let originalGetContext: HTMLCanvasElement["getContext"]

beforeEach(() => {
  originalGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
})

afterEach(() => {
  cleanup()
  HTMLCanvasElement.prototype.getContext = originalGetContext
  vi.unstubAllGlobals()
})

describe("the Talk orb comparison harness", () => {
  it("renders one inspectable preview for every variant and state", () => {
    render(<TalkOrbHarnessPage />)

    for (const variant of VARIANTS) {
      for (const state of STATES) {
        const selector = `[data-orb-preview][data-orb-variant="${variant}"][data-orb-state="${state}"]`
        expect(document.querySelectorAll(selector), `${variant} / ${state}`).toHaveLength(1)
      }
    }
  })

  it("labels all four strategies so comparison does not depend on colour", () => {
    render(<TalkOrbHarnessPage />)

    for (const variant of VARIANTS) {
      expect(document.querySelector(`[data-orb-variant-heading="${variant}"]`)).not.toBeNull()
    }
  })
})
