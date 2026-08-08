import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const authFetch = vi.fn()

vi.mock("@/lib/auth", () => ({
  authFetch: (...args: unknown[]) => authFetch(...args),
}))

const {
  HEARTBEAT_INTERVAL_MS,
  closeTalkSession,
  openTalkSession,
  parkTalkSession,
  postTalkTurn,
  resumeTalkSession,
  startTalkHeartbeat,
} = await import("../session-client")
const { emptyTalkUsage } = await import("../usage-delta")

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

const OPENED = { id: "talk-1", token: "ephemeral-secret", expiresAt: 1_700_000_600, model: "gpt-realtime-2.1" }

beforeEach(() => {
  authFetch.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("opening a session", () => {
  it("posts the collection once and hands back the credential it minted", async () => {
    authFetch.mockResolvedValue(json(OPENED, 201))

    const opened = await openTalkSession()

    expect(opened).toMatchObject({ id: "talk-1", token: "ephemeral-secret" })
    expect(authFetch).toHaveBeenCalledTimes(1)
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/talk/sessions")
    expect(init.method).toBe("POST")
  })

  it("reports the gateway's own words when voice is not configured", async () => {
    authFetch.mockResolvedValue(json({ error: "Voice is not available: realtime is not configured" }, 503))

    await expect(openTalkSession()).rejects.toThrow("Voice is not available: realtime is not configured")
  })

  it("reports the gateway's own words when the provider refuses to mint", async () => {
    authFetch.mockResolvedValue(
      json({ error: "The realtime provider refused to issue a session credential." }, 502),
    )

    await expect(openTalkSession()).rejects.toThrow("refused to issue a session credential")
  })

  it("still says something useful when the failure carries no message at all", async () => {
    authFetch.mockResolvedValue(new Response("<html>gateway down</html>", { status: 502 }))

    await expect(openTalkSession()).rejects.toThrow("502")
  })

  it("refuses a response that names no session, rather than opening against undefined", async () => {
    authFetch.mockResolvedValue(json({ token: "ephemeral-secret" }, 201))

    await expect(openTalkSession()).rejects.toThrow(/id/)
  })
})

describe("the rest of the lifecycle", () => {
  it("closes with a DELETE on the session itself", async () => {
    authFetch.mockResolvedValue(json({ id: "talk-1", state: "closed" }))

    await closeTalkSession("talk-1")

    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/talk/sessions/talk-1")
    expect(init.method).toBe("DELETE")
    // Sent from a page that may be going away, so the browser is asked to finish it.
    expect(init.keepalive).toBe(true)
  })

  it("parks and resumes, and a resume brings back a credential that outlives the old one", async () => {
    authFetch.mockResolvedValueOnce(json({ id: "talk-1", state: "parked" }))
    authFetch.mockResolvedValueOnce(json({ token: "second-secret", expiresAt: 1_700_001_200 }))

    await parkTalkSession("talk-1")
    const resumed = await resumeTalkSession("talk-1")

    expect(authFetch.mock.calls[0]![0]).toBe("/api/talk/sessions/talk-1/park")
    expect(authFetch.mock.calls[1]![0]).toBe("/api/talk/sessions/talk-1/resume")
    expect(resumed).toEqual({ token: "second-secret", expiresAt: 1_700_001_200 })
  })

  it("posts a turn's usage and what was said", async () => {
    authFetch.mockResolvedValue(json({ spendUsd: 0.02 }))

    await postTalkTurn("talk-1", { ...emptyTalkUsage(), inputAudioTokens: 900 }, "open ABC-1")

    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/talk/sessions/talk-1/turn")
    expect(JSON.parse(String(init.body))).toEqual({
      usage: { ...emptyTalkUsage(), inputAudioTokens: 900 },
      transcript: "open ABC-1",
    })
  })

  it("escapes an id rather than letting it shape the path", async () => {
    authFetch.mockResolvedValue(json({ id: "x", state: "closed" }))

    await closeTalkSession("talk 1/../other")

    expect(authFetch.mock.calls[0]![0]).toBe("/api/talk/sessions/talk%201%2F..%2Fother")
  })
})

describe("the heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    authFetch.mockResolvedValue(json({ id: "talk-1", state: "live" }))
  })

  it("is three times slower than the gateway's ninety-second reaper", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000)
  })

  it("beats on the interval and not before it", async () => {
    startTalkHeartbeat("talk-1")

    expect(authFetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    expect(authFetch).toHaveBeenCalledTimes(1)
    expect(authFetch.mock.calls[0]![0]).toBe("/api/talk/sessions/talk-1/heartbeat")
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2)
    expect(authFetch).toHaveBeenCalledTimes(3)
  })

  it("stops for good once the session is closed", async () => {
    const stop = startTalkHeartbeat("talk-1")

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    stop()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 5)

    expect(authFetch).toHaveBeenCalledTimes(1)
  })

  it("keeps beating when one beat fails, because the next one is what re-attaches", async () => {
    authFetch.mockRejectedValueOnce(new Error("offline"))
    startTalkHeartbeat("talk-1")

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2)

    expect(authFetch).toHaveBeenCalledTimes(2)
  })
})
