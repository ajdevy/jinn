import { act, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const authFetch = vi.fn()
vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>()
  return { ...original, authFetch: (...args: unknown[]) => authFetch(...args) }
})

const { useTalkSession } = await import("../use-talk-session")
const { useTalkSessionId, setTalkSessionId } = await import("@/components/talk/talk-session-store")
const { HEARTBEAT_INTERVAL_MS } = await import("../session-client")
const { FakeConnection, connect, holdNextConnect } = await import("./fake-connection")
const { pageContextListenerCount, resetPageContext } = await import("@/components/talk/context/page-context-store")

let handle: ReturnType<typeof useTalkSession>

function Probe() {
  handle = useTalkSession(connect)
  return <span data-testid="open-session">{useTalkSessionId() ?? "none"}</span>
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

const OPENED = { id: "talk-1", token: "secret-1", expiresAt: 1_700_000_600, model: "gpt-realtime-2.1" }

/** Every request this test made against one path suffix. */
function calls(match: string) {
  return authFetch.mock.calls.filter(([url]) => String(url).endsWith(match))
}

function openSucceeds() {
  authFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url === "/api/talk/sessions" && init.method === "POST") return json(OPENED, 201)
    if (url.endsWith("/resume")) return json({ token: "secret-2", expiresAt: 1_700_001_200 })
    return json({ ok: true })
  })
}

async function activate() {
  await act(async () => handle.toggle())
  await waitFor(() => expect(handle.active).toBe(true))
}

beforeEach(() => {
  authFetch.mockReset()
  connect.mockClear()
  FakeConnection.opened = []
  setTalkSessionId(null)
  resetPageContext()
})

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(document, "hidden", { configurable: true, value: false })
})

describe("mounting", () => {
  it("opens nothing and touches no microphone until the orb is activated", () => {
    openSucceeds()

    const { getByTestId } = render(<Probe />)

    expect(authFetch).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
    expect(getByTestId("open-session").textContent).toBe("none")
    expect(handle.active).toBe(false)
  })
})

describe("activating and deactivating", () => {
  it("opens exactly one session and names it in the store", async () => {
    openSucceeds()
    const { getByTestId } = render(<Probe />)

    await activate()

    expect(calls("/api/talk/sessions")).toHaveLength(1)
    expect(getByTestId("open-session").textContent).toBe("talk-1")
    expect(connect).toHaveBeenCalledTimes(1)
    expect(connect.mock.calls[0]![0].token).toBe("secret-1")
  })

  it("does not open a second session while the first is still opening", async () => {
    openSucceeds()
    render(<Probe />)

    await act(async () => {
      handle.toggle()
      handle.toggle()
    })
    await waitFor(() => expect(handle.active).toBe(true))

    expect(calls("/api/talk/sessions")).toHaveLength(1)
  })

  it("closes the session and empties the store on the way out", async () => {
    openSucceeds()
    const { getByTestId } = render(<Probe />)
    await activate()

    await act(async () => handle.toggle())

    await waitFor(() => expect(handle.active).toBe(false))
    const closed = authFetch.mock.calls.find(([, init]) => (init as RequestInit)?.method === "DELETE")
    expect(closed![0]).toBe("/api/talk/sessions/talk-1")
    expect(getByTestId("open-session").textContent).toBe("none")
    expect(FakeConnection.opened[0]!.closes).toBe(1)
  })

  it("declares its tools once the channel opens", async () => {
    openSucceeds()
    render(<Probe />)

    await activate()

    await waitFor(() => expect(FakeConnection.opened[0]!.sent).toHaveLength(1))
    expect(FakeConnection.opened[0]!.sent[0]!.type).toBe("session.update")
  })
})

describe("an open that fails", () => {
  it.each([
    [503, "Voice is not available: realtime is not configured"],
    [502, "The realtime provider refused to issue a session credential."],
  ])("leaves the orb idle and the store empty on %i", async (status, message) => {
    authFetch.mockResolvedValue(json({ error: message }, status))
    const { getByTestId } = render(<Probe />)

    await act(async () => handle.toggle())

    await waitFor(() => expect(handle.error).toBe(message))
    expect(handle.active).toBe(false)
    expect(handle.state).toBe("idle")
    expect(getByTestId("open-session").textContent).toBe("none")
    expect(connect).not.toHaveBeenCalled()
  })

  it("closes a session that opened but never connected, rather than half-holding it", async () => {
    openSucceeds()
    connect.mockRejectedValueOnce(new Error("the microphone was refused"))
    const { getByTestId } = render(<Probe />)

    await act(async () => handle.toggle())

    await waitFor(() => expect(handle.error).toBe("the microphone was refused"))
    expect(getByTestId("open-session").textContent).toBe("none")
    expect(authFetch.mock.calls.some(([, init]) => (init as RequestInit)?.method === "DELETE")).toBe(true)
  })
})

describe("the heartbeat", () => {
  it("beats every thirty seconds while live, and never again after close", async () => {
    openSucceeds()
    // Installed before the session opens, so the interval it starts is the fake
    // one. A heartbeat started under real timers would never be driven here.
    vi.useFakeTimers()
    render(<Probe />)
    // `waitFor` polls on a timer, so activation is flushed by advancing instead.
    await act(async () => {
      handle.toggle()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(handle.active).toBe(true)

    await act(() => vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3))
    expect(calls("/heartbeat")).toHaveLength(3)

    await act(async () => {
      handle.toggle()
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(() => vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 5))

    expect(calls("/heartbeat")).toHaveLength(3)
  })
})

describe("leaving and coming back", () => {
  function setHidden(hidden: boolean) {
    Object.defineProperty(document, "hidden", { configurable: true, value: hidden })
    document.dispatchEvent(new Event("visibilitychange"))
  }

  it("parks and cools the microphone when the tab goes away", async () => {
    openSucceeds()
    render(<Probe />)
    await activate()

    await act(async () => setHidden(true))

    await waitFor(() => expect(calls("/park")).toHaveLength(1))
    expect(FakeConnection.opened[0]!.closes).toBe(1)
    expect(handle.state).toBe("idle")
  })

  it("resumes on the credential the gateway hands back", async () => {
    openSucceeds()
    render(<Probe />)
    await activate()
    await act(async () => setHidden(true))
    await waitFor(() => expect(calls("/park")).toHaveLength(1))

    await act(async () => setHidden(false))

    await waitFor(() => expect(FakeConnection.opened).toHaveLength(2))
    expect(calls("/resume")).toHaveLength(1)
    expect(FakeConnection.opened[1]!.token).toBe("secret-2")
    await waitFor(() => expect(handle.state).toBe("listening"))
  })

  it("lets go of the page store on every drop, so parking and resuming leaks no follower", async () => {
    openSucceeds()
    render(<Probe />)
    await activate()
    expect(pageContextListenerCount()).toBe(1)

    for (const round of [1, 2]) {
      await act(async () => setHidden(true))
      await waitFor(() => expect(calls("/park")).toHaveLength(round))
      // A parked session has no channel, so it must have no follower either.
      expect(pageContextListenerCount()).toBe(0)
      await act(async () => setHidden(false))
      await waitFor(() => expect(handle.state).toBe("listening"))
      expect(pageContextListenerCount()).toBe(1)
    }

    await act(async () => handle.toggle())
    await waitFor(() => expect(handle.active).toBe(false))
    expect(pageContextListenerCount()).toBe(0)
  })

  it("stands down when the session it parked has been reaped", async () => {
    openSucceeds()
    render(<Probe />)
    await activate()
    await act(async () => setHidden(true))
    await waitFor(() => expect(calls("/park")).toHaveLength(1))
    authFetch.mockResolvedValue(json({ error: "Talk session talk-1 does not exist" }, 404))

    await act(async () => setHidden(false))

    await waitFor(() => expect(handle.error).toContain("does not exist"))
    expect(handle.active).toBe(false)
  })

  it("closes the session when the page goes away", async () => {
    openSucceeds()
    render(<Probe />)
    await activate()

    await act(async () => {
      window.dispatchEvent(new Event("pagehide"))
    })

    await waitFor(() =>
      expect(authFetch.mock.calls.some(([, init]) => (init as RequestInit)?.method === "DELETE")).toBe(true),
    )
    expect(FakeConnection.opened[0]!.closes).toBe(1)
  })

  it("closes a session whose page left while it was still connecting", async () => {
    openSucceeds()
    const finishConnecting = holdNextConnect()
    const { getByTestId } = render(<Probe />)
    await act(async () => handle.toggle())
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))

    await act(async () => window.dispatchEvent(new Event("pagehide")))
    await act(async () => finishConnecting())

    await waitFor(() =>
      expect(authFetch.mock.calls.some(([, init]) => (init as RequestInit)?.method === "DELETE")).toBe(true),
    )
    expect(FakeConnection.opened[0]!.closes).toBe(1)
    expect(calls("/heartbeat")).toHaveLength(0)
    expect(handle.active).toBe(false)
    expect(getByTestId("open-session").textContent).toBe("none")
  })

  it("does not bring the microphone back for a session closed while it was resuming", async () => {
    openSucceeds()
    render(<Probe />)
    await activate()
    await act(async () => setHidden(true))
    await waitFor(() => expect(calls("/park")).toHaveLength(1))
    const finishConnecting = holdNextConnect()
    await act(async () => setHidden(false))
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(2))

    await act(async () => handle.toggle())
    await waitFor(() => expect(handle.active).toBe(false))
    await act(async () => finishConnecting())

    await waitFor(() => expect(FakeConnection.opened[1]!.closes).toBe(1))
    expect(handle.state).toBe("idle")
  })
})
