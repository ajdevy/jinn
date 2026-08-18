import { act, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const authFetch = vi.fn()
vi.mock("@/lib/auth", () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }))
vi.mock("@/hooks/use-gateway", () => ({ useGateway: () => ({ subscribe: () => () => {} }) }))

const { TalkLiveSurface } = await import("../talk-live-surface")
const { clearTalkNavigator, registerTalkNavigator } = await import("../tools/router-handle")

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function renderSurface() {
  return render(<TalkLiveSurface />)
}

async function press(name: string) {
  await act(async () => { screen.getByRole("button", { name }).click() })
}

beforeEach(() => {
  authFetch.mockReset()
  clearTalkNavigator()
  authFetch.mockImplementation(async (url: string) => {
    if (url === "/api/talk/config") {
      return json({ configured: false, provider: null, providers: ["openai"] })
    }
    return json({ error: "Voice is not available.", reason: "unconfigured" }, 503)
  })
})

describe("the live Aurora surface", () => {
  it("reports setup and provider failures through orb motion, never a Talk card", async () => {
    renderSurface()

    await press("Start voice session")

    await waitFor(() => expect(screen.getByRole("button", { name: "Open voice settings" }).getAttribute("data-orb-state")).toBe("error"))
    expect(document.querySelector("[data-talk-situation]")).toBeNull()
    expect(document.querySelector("[data-talk-undo]")).toBeNull()
    expect(document.body.textContent).toBe("")
  })

  it("sends an unconfigured operator to existing settings on the next press", async () => {
    const navigate = vi.fn().mockResolvedValue(undefined)
    registerTalkNavigator(navigate)
    renderSurface()
    await press("Start voice session")
    await waitFor(() => expect(screen.getByRole("button", { name: "Open voice settings" })).toBeTruthy())

    await press("Open voice settings")

    expect(navigate).toHaveBeenCalledWith("/settings")
  })
})
