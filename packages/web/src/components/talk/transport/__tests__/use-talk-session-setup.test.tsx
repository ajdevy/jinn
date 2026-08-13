/**
 * The orb pressed on a gateway where voice was never configured. It asks before
 * it mints, so nothing here should reach `/api/talk/sessions` at all.
 */

import { act, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const authFetch = vi.fn()
vi.mock("@/lib/auth", () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }))

const { useTalkSession } = await import("../use-talk-session")
const { useTalkSessionId, setTalkSessionId } = await import("@/components/talk/talk-session-store")
const { FakeConnection, connect } = await import("./fake-connection")

let handle: ReturnType<typeof useTalkSession>

function Probe() {
  handle = useTalkSession(connect)
  return <span data-testid="open-session">{useTalkSessionId() ?? "none"}</span>
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

/** Every request this test made against one path suffix. */
function calls(match: string) {
  return authFetch.mock.calls.filter(([url]) => String(url).endsWith(match))
}

const CONFIGURED = { configured: true, provider: "openai", providers: ["openai"] }
const UNCONFIGURED = { configured: false, provider: null, providers: ["openai"] }

beforeEach(() => {
  authFetch.mockReset()
  connect.mockClear()
  FakeConnection.opened = []
  setTalkSessionId(null)
})

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(document, "hidden", { configurable: true, value: false })
})

describe("voice that was never set up", () => {
  it("asks for setup instead of minting, and says nothing about an error", async () => {
    authFetch.mockImplementation(async (url: string) =>
      url === "/api/talk/config" ? json(UNCONFIGURED) : json({ ok: true }),
    )
    const { getByTestId } = render(<Probe />)

    await act(async () => handle.toggle())

    await waitFor(() => expect(handle.setup).toEqual({ providers: ["openai"] }))
    expect(calls("/api/talk/sessions")).toHaveLength(0)
    expect(handle.error).toBeNull()
    expect(handle.active).toBe(false)
    expect(handle.state).toBe("idle")
    expect(getByTestId("open-session").textContent).toBe("none")
    expect(connect).not.toHaveBeenCalled()
  })

  // The probe and the mint are two calls, so the config can change between them.
  it("asks for setup when the mint itself refuses for want of configuration", async () => {
    authFetch.mockImplementation(async (url: string) =>
      url === "/api/talk/config"
        ? json(CONFIGURED)
        : json({ error: "Voice is not available.", reason: "unconfigured" }, 503),
    )
    render(<Probe />)

    await act(async () => handle.toggle())

    await waitFor(() => expect(handle.setup).toEqual({ providers: ["openai"] }))
    expect(handle.error).toBeNull()
    expect(connect).not.toHaveBeenCalled()
  })
})
