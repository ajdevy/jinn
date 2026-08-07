import { act, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DEFAULTS, type JinnSettings } from "@/lib/settings"
import { TalkOrbOverlay } from "../talk-orb-overlay"
import { setTalkSessionId } from "../talk-session-store"

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

const bindTalkActionLog = vi.fn()
vi.mock("../talk-action-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../talk-action-log")>()),
  bindTalkActionLog: (id: string | null) => bindTalkActionLog(id),
}))

function withTalkOrb(enabled: boolean) {
  stored.settings = { ...DEFAULTS, talkOrb: enabled }
}

afterEach(() => {
  orb.loads = 0
  bindTalkActionLog.mockClear()
  act(() => setTalkSessionId(null))
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

    await waitFor(() => expect(document.querySelector("[data-talk-orb]")).not.toBeNull())
    expect(orb.loads).toBe(1)
  })

  it("hands the open talk session down to the surface, and lets it go on the way out", async () => {
    withTalkOrb(true)
    act(() => setTalkSessionId("talk-9"))

    const mounted = render(<TalkOrbOverlay />)
    await waitFor(() => expect(bindTalkActionLog).toHaveBeenLastCalledWith("talk-9"))

    mounted.unmount()

    expect(bindTalkActionLog).toHaveBeenLastCalledWith(null)
  })

  it("binds no session while none is open, which is what production does today", async () => {
    withTalkOrb(true)

    render(<TalkOrbOverlay />)

    await waitFor(() => expect(bindTalkActionLog).toHaveBeenCalled())
    expect(bindTalkActionLog).toHaveBeenLastCalledWith(null)
  })
})
