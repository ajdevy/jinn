import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const authFetch = vi.fn()
vi.mock("@/lib/auth", () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }))

const updateConfig = vi.fn()
vi.mock("@/lib/api", () => ({ api: { updateConfig: (...args: unknown[]) => updateConfig(...args) } }))

const { TalkLiveSurface } = await import("../talk-live-surface")
const { clearSituations } = await import("./situation-fixtures")

/**
 * What the operator meets on a first press of the orb.
 *
 * The whole point of PLA-79 is that this is a card and not the provider
 * factory's exception, so the assertions are as much about what is absent from
 * the screen as about what is on it.
 */

/** The two sentences `UnknownRealtimeProviderError` builds. Neither is copy the
 *  operator should ever be shown; they exist here only to be looked for. */
const FACTORY_SENTENCES = ["realtime.provider is not set", "set realtime.provider to one of"]

const OPENED = { id: "talk-1", token: "secret-1", expiresAt: 1_700_000_600, model: "gpt-realtime-2.1" }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

/** A gateway with no realtime block at all: the probe says no, and the mint
 *  would refuse with exactly the exception this ticket is about. */
function unconfiguredGateway() {
  authFetch.mockImplementation(async (url: string) => {
    if (url === "/api/talk/config") return json({ configured: false, provider: null, providers: ["openai"] })
    return json(
      {
        error: "Voice is not available.",
        reason: "unconfigured",
        detail: "realtime.provider is not set — set realtime.provider to one of: openai",
      },
      503,
    )
  })
}

function pressOrb() {
  return act(async () => {
    screen.getByRole("button", { name: "Start voice session" }).click()
  })
}

beforeEach(() => {
  authFetch.mockReset()
  updateConfig.mockReset()
  updateConfig.mockResolvedValue({})
  clearSituations()
})

describe("pressing the orb with voice unconfigured", () => {
  it("opens the setup card rather than a session", async () => {
    unconfiguredGateway()
    render(<TalkLiveSurface />)

    await pressOrb()

    await waitFor(() => expect(document.querySelector('[data-situation-renderer="voice-setup"]')).not.toBeNull())
    expect(authFetch.mock.calls.filter(([url]) => url === "/api/talk/sessions")).toHaveLength(0)
  })

  it("shows the operator none of the factory's words", async () => {
    unconfiguredGateway()
    render(<TalkLiveSurface />)

    await pressOrb()

    await waitFor(() => expect(document.querySelector('[data-situation-renderer="voice-setup"]')).not.toBeNull())
    for (const sentence of FACTORY_SENTENCES) {
      expect(document.body.textContent).not.toContain(sentence)
    }
    expect(document.querySelector('[data-situation-renderer="prose"]')).toBeNull()
  })

  it("opens a session on the next press once the card has been saved", async () => {
    unconfiguredGateway()
    render(<TalkLiveSurface />)
    await pressOrb()
    await screen.findByLabelText("Voice API key")

    // Saving is what the gateway would have been reconfigured by, so the probe
    // answers differently from here on.
    authFetch.mockImplementation(async (url: string) => {
      if (url === "/api/talk/config") return json({ configured: true, provider: "openai", providers: ["openai"] })
      if (url === "/api/talk/sessions") return json(OPENED, 201)
      return json({ ok: true })
    })

    fireEvent.change(screen.getByLabelText("Voice API key"), { target: { value: "sk-account-key" } })
    await act(async () => {
      screen.getByRole("button", { name: /save/i }).click()
    })

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({ realtime: { provider: "openai", apiKey: "sk-account-key" } }),
    )
    await waitFor(() =>
      expect(authFetch.mock.calls.filter(([url]) => url === "/api/talk/sessions").length).toBeGreaterThan(0),
    )
    expect(document.querySelector('[data-situation-renderer="voice-setup"]')).toBeNull()
  })
})
