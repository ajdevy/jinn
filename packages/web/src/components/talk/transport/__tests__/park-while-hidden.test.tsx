import { act, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { authFetch, activate, calls, handle, json, openSucceeds, Probe, resetHarness } from "./talk-session-harness"

vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>()
  return { ...original, authFetch: (...args: unknown[]) => authFetch(...args) }
})

const { FakeConnection, connect, holdNextConnect } = await import("./fake-connection")
const { pageContextListenerCount } = await import("@/components/talk/context/page-context-store")

beforeEach(resetHarness)

afterEach(() => {
  Object.defineProperty(document, "hidden", { configurable: true, value: false })
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
    // Handed back whole: a driver left running would go on following the page
    // for a session that no longer has a channel to carry what it reads.
    expect(pageContextListenerCount()).toBe(0)
    expect(handle.state).toBe("idle")
  })
})
