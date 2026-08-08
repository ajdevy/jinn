import { render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DEFAULTS, type JinnSettings } from "@/lib/settings"
import { TalkOrbOverlay } from "../talk-orb-overlay"

/** Counts module evaluations, so "the chunk is not fetched" is an assertion
 *  rather than a hope: the factory only runs when the lazy import resolves. */
const orb = vi.hoisted(() => ({ loads: 0 }))

vi.mock("../talk-orb", () => {
  orb.loads += 1
  return { TalkOrb: () => <div data-talk-orb /> }
})

const stored = vi.hoisted(() => ({ settings: {} as JinnSettings }))

vi.mock("@/routes/settings-provider", () => ({
  useSettings: () => ({ settings: stored.settings }),
}))

function withTalkOrb(enabled: boolean) {
  stored.settings = { ...DEFAULTS, talkOrb: enabled }
}

afterEach(() => {
  orb.loads = 0
})

describe("TalkOrbOverlay", () => {
  it("is off by default", () => {
    expect(DEFAULTS.talkOrb).toBe(false)
  })

  it("renders nothing and loads nothing while the setting is off", () => {
    withTalkOrb(false)

    const { container } = render(<TalkOrbOverlay />)

    expect(container.innerHTML).toBe("")
    expect(orb.loads).toBe(0)
  })

  it("renders the sphere once the setting is on", async () => {
    withTalkOrb(true)

    render(<TalkOrbOverlay />)

    // waitFor's one-second default is a budget for a render, and this waits on a
    // cold dynamic import instead: transforming the talk-surface module graph
    // costs ~520ms on an idle machine, so a loaded one times out.
    await waitFor(() => expect(document.querySelector("[data-talk-orb]")).not.toBeNull(), {
      timeout: 15_000,
    })
    expect(orb.loads).toBe(1)
  })
})
