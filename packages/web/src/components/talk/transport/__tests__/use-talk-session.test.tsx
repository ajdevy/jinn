import { act, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  authFetch,
  activate,
  calls,
  CONFIGURED,
  handle,
  json,
  OPENED,
  openSucceeds,
  Probe,
  resetHarness,
} from "./talk-session-harness"

vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>()
  return { ...original, authFetch: (...args: unknown[]) => authFetch(...args) }
})

const { HEARTBEAT_INTERVAL_MS } = await import("../session-client")
const { FakeConnection, connect, holdNextConnect } = await import("./fake-connection")
const {
  readResumableTalkSession,
  rememberResumableTalkSession,
} = await import("@/components/talk/talk-session-store")

beforeEach(resetHarness)

afterEach(() => {
  vi.useRealTimers()
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

  it("discovers and advertises a parked candidate without minting, connecting, or asking for capability", async () => {
    rememberResumableTalkSession("talk-1")
    authFetch.mockResolvedValue(json({
      ...OPENED,
      state: "parked",
      token: undefined,
      brief: "remember this decision",
    }))

    const { getByTestId } = render(<Probe />)

    await waitFor(() => expect(getByTestId("open-session").textContent).toBe("talk-1"))
    expect(authFetch).toHaveBeenCalledTimes(1)
    expect(authFetch.mock.calls[0]![0]).toBe("/api/talk/sessions/talk-1")
    expect((authFetch.mock.calls[0]![1] as RequestInit).method).toBe("GET")
    expect(calls("/api/talk/config")).toHaveLength(0)
    expect(calls("/resume")).toHaveLength(0)
    expect(connect).not.toHaveBeenCalled()
    expect(handle.active).toBe(false)
    expect(handle.parked).toBe(true)
  })
})

describe("cold recovery", () => {
  function parkedStatus() {
    return json({ ...OPENED, state: "parked", token: undefined, brief: "remember this decision" })
  }

  it("resumes the old session only after a fresh orb press", async () => {
    rememberResumableTalkSession("talk-1")
    authFetch.mockImplementation(async (url: string) => {
      if (url === "/api/talk/sessions/talk-1") return parkedStatus()
      if (url.endsWith("/resume")) return json({
        token: "secret-2",
        expiresAt: 1_700_001_200,
        browserInstanceId: OPENED.browserInstanceId,
        credentialGeneration: 2,
      })
      return json({ ok: true })
    })
    render(<Probe />)
    await waitFor(() => expect(handle.parked).toBe(true))

    await act(async () => handle.toggle())

    await waitFor(() => expect(handle.active).toBe(true))
    expect(calls("/park")).toHaveLength(0)
    expect(calls("/resume")).toHaveLength(1)
    expect(calls("/api/talk/config")).toHaveLength(0)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(FakeConnection.opened[0]!.token).toBe("secret-2")
  })

  it("clears a missing candidate and opens a new session on the next press", async () => {
    rememberResumableTalkSession("talk-stale")
    authFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
      if (url === "/api/talk/sessions/talk-stale") return json({ error: "gone" }, 404)
      if (url === "/api/talk/config") return json(CONFIGURED)
      if (url === "/api/talk/sessions" && init.method === "POST") return json(OPENED, 201)
      return json({ ok: true })
    })
    render(<Probe />)
    await waitFor(() => expect(readResumableTalkSession()).toBeNull())

    await act(async () => handle.toggle())

    await waitFor(() => expect(handle.active).toBe(true))
    expect(calls("/api/talk/config")).toHaveLength(1)
    expect(calls("/api/talk/sessions")).toHaveLength(1)
    expect(readResumableTalkSession()).toBe("talk-1")
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
    expect(readResumableTalkSession()).toBe("talk-1")
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
    expect(readResumableTalkSession()).toBeNull()
  })

  it("starts over through a fresh Talk runtime while leaving the old normal chat alone", async () => {
    let opens = 0
    authFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
      if (url === "/api/talk/config") return json(CONFIGURED)
      if (url === "/api/talk/sessions" && init.method === "POST") {
        opens += 1
        return json({ ...OPENED, id: `talk-${opens}`, token: `secret-${opens}` }, 201)
      }
      return json({ ok: true })
    })
    render(<Probe />)
    await activate()

    await act(async () => handle.startOver())

    await waitFor(() => expect(handle.active).toBe(true))
    expect(authFetch.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "DELETE")[0]![0])
      .toBe("/api/talk/sessions/talk-1")
    expect(authFetch.mock.calls.some(([url]) => String(url).startsWith("/api/sessions/"))).toBe(false)
    expect(calls("/api/talk/sessions")).toHaveLength(2)
    expect(readResumableTalkSession()).toBe("talk-2")
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
  it.each([[502, "The realtime provider refused to issue a session credential."]])(
    "leaves the orb idle and the store empty on %i",
    async (status, message) => {
      authFetch.mockImplementation(async (url: string) =>
        url === "/api/talk/config" ? json(CONFIGURED) : json({ error: message }, status),
      )
      const { getByTestId } = render(<Probe />)

      await act(async () => handle.toggle())

      await waitFor(() => expect(handle.error).toBe(message))
      expect(handle.setup).toBeNull()
      expect(handle.active).toBe(false)
      expect(handle.state).toBe("idle")
      expect(getByTestId("open-session").textContent).toBe("none")
      expect(connect).not.toHaveBeenCalled()
    },
  )

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

describe("the page going away", () => {
  it("detaches and parks the session when the page goes away without deleting history", async () => {
    openSucceeds()
    render(<Probe />)
    await activate()

    await act(async () => {
      window.dispatchEvent(new Event("pagehide"))
    })

    await waitFor(() => expect(calls("/park")).toHaveLength(1))
    expect(authFetch.mock.calls.some(([, init]) => (init as RequestInit)?.method === "DELETE")).toBe(false)
    expect(FakeConnection.opened[0]!.closes).toBe(1)
    expect(readResumableTalkSession()).toBe("talk-1")
  })

  it("parks a session whose page left while it was still connecting", async () => {
    openSucceeds()
    const finishConnecting = holdNextConnect()
    const { getByTestId } = render(<Probe />)
    await act(async () => handle.toggle())
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))

    await act(async () => window.dispatchEvent(new Event("pagehide")))
    await act(async () => finishConnecting())

    await waitFor(() => expect(calls("/park")).toHaveLength(1))
    expect(authFetch.mock.calls.some(([, init]) => (init as RequestInit)?.method === "DELETE")).toBe(false)
    expect(FakeConnection.opened[0]!.closes).toBe(1)
    expect(calls("/heartbeat")).toHaveLength(0)
    expect(handle.active).toBe(false)
    expect(getByTestId("open-session").textContent).toBe("none")
    expect(readResumableTalkSession()).toBe("talk-1")
  })
})
