import { act, render, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { activate, authFetch, CONFIGURED, handle, json, OPENED, Probe, resetHarness } from "./talk-session-harness"

vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>()
  return { ...original, authFetch: (...args: unknown[]) => authFetch(...args) }
})

const { FakeConnection } = await import("./fake-connection")

beforeEach(resetHarness)

describe("a dropped realtime provider", () => {
  it("shows an error and retries without preserving a dead attachment", async () => {
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

    act(() => FakeConnection.opened[0]!.fail())
    await waitFor(() => expect(handle.state).toBe("error"))
    expect(handle.error).toBe("The realtime connection was interrupted.")

    await act(async () => handle.toggle())

    await waitFor(() => expect(FakeConnection.opened).toHaveLength(2))
    expect(handle.active).toBe(true)
    expect(FakeConnection.opened[0]!.closes).toBe(1)
  })
})
