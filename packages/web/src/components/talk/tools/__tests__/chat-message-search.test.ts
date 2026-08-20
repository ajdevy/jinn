import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { describeLocation } from "../../context/page-snapshot"
import { getPageContext, publishPageContext, resetPageContext } from "../../context/page-context-store"
import { CHAT_MESSAGE_SEARCH_TOOL } from "../chat-message-search"
import { executeToolCall, findTool } from "../registry"

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch }))

const NOW = Date.parse("2026-08-18T12:00:00.000Z")
const CURRENT_SESSION = "123e4567-e89b-12d3-a456-426614174000"
const OTHER_SESSION = "223e4567-e89b-12d3-a456-426614174000"

function response(results: unknown[]): Response {
  return { ok: true, json: async () => ({ results }) } as Response
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  resetPageContext()
  authFetch.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  resetPageContext()
})

describe("talk_search_chat_messages", () => {
  it("searches only the current chat and returns bounded speakable excerpts", async () => {
    publishPageContext(describeLocation("/", `?session=${CURRENT_SESSION}`))
    authFetch.mockResolvedValue(response([
      {
        messageId: "message-private-1",
        sessionId: CURRENT_SESSION,
        role: "assistant",
        timestamp: NOW - 30_000,
        snippet: `We chose the «ring orb» ${CURRENT_SESSION} Bearer private-token ${"detail ".repeat(60)}`,
        employee: "platform-lead",
        engine: "codex",
      },
      { sessionId: OTHER_SESSION, role: "assistant", timestamp: NOW, snippet: "cross-chat canary" },
      ...Array.from({ length: 7 }, (_, index) => ({
        messageId: `message-private-${index + 2}`,
        sessionId: CURRENT_SESSION,
        role: index % 2 === 0 ? "user" : "assistant",
        timestamp: NOW - (index + 2) * 3_600_000,
        snippet: `matching orb excerpt ${index}`,
      })),
      { role: "notification", timestamp: NOW, snippet: "must not enter Talk output" },
    ]))
    const before = getPageContext()

    const result = await executeToolCall(CHAT_MESSAGE_SEARCH_TOOL.name, JSON.stringify({ query: "ring orb" }))

    expect(authFetch).toHaveBeenCalledWith(
      `/api/search/messages?q=ring%20orb&sessionId=${encodeURIComponent(CURRENT_SESSION)}&limit=6`,
      { method: "GET" },
    )
    expect(result).toMatchObject({ ok: true, data: { matches: expect.any(Array) } })
    const serialized = JSON.stringify(result)
    const matches = result.ok ? result.data.matches as Array<Record<string, unknown>> : []
    expect(matches).toHaveLength(6)
    expect(matches[0]).toEqual({ role: "assistant", excerpt: expect.stringContaining("ring orb"), when: "just now" })
    expect(matches.every((match) => String(match.excerpt).length <= 240)).toBe(true)
    expect(Object.keys(matches[0]!).sort()).toEqual(["excerpt", "role", "when"])
    expect(serialized).not.toContain(CURRENT_SESSION)
    expect(serialized).not.toContain("private-token")
    expect(serialized).not.toContain("message-private")
    expect(serialized).not.toContain("platform-lead")
    expect(serialized).not.toContain("codex")
    expect(serialized).not.toContain("must not enter")
    expect(serialized).not.toContain("cross-chat canary")
    expect(getPageContext()).toBe(before)
  })

  it("discards excerpts if the operator switches chats while the search is in flight", async () => {
    publishPageContext(describeLocation("/", `?session=${CURRENT_SESSION}`))
    let settle!: (value: Response) => void
    authFetch.mockReturnValue(new Promise<Response>((resolve) => { settle = resolve }))

    const searching = executeToolCall(CHAT_MESSAGE_SEARCH_TOOL.name, JSON.stringify({ query: "orb decision" }))
    publishPageContext(describeLocation("/", `?session=${OTHER_SESSION}`))
    settle(response([{ role: "user", timestamp: NOW - 86_400_000, snippet: "Earlier orb decision" }]))
    const result = await searching

    expect(result).toEqual({ ok: false, error: expect.stringContaining("chat changed") })
    expect(JSON.stringify(result)).not.toContain("Earlier orb decision")
  })

  it("fails closed for a missing chat scope, blank query, or oversized query", async () => {
    expect(await CHAT_MESSAGE_SEARCH_TOOL.execute({ query: "orb" })).toEqual({
      ok: false,
      error: expect.stringContaining("Open a chat"),
    })
    publishPageContext(describeLocation("/", `?session=${CURRENT_SESSION}`))
    expect(await CHAT_MESSAGE_SEARCH_TOOL.execute({ query: "   " })).toEqual({
      ok: false,
      error: expect.stringContaining("what to search for"),
    })
    expect(await CHAT_MESSAGE_SEARCH_TOOL.execute({ query: "x".repeat(513) })).toEqual({
      ok: false,
      error: expect.stringContaining("512"),
    })
    expect(authFetch).not.toHaveBeenCalled()
  })

  it("returns a successful empty match set without widening the scope", async () => {
    publishPageContext(describeLocation("/", `?session=${CURRENT_SESSION}`))
    authFetch.mockResolvedValue(response([]))

    const result = await CHAT_MESSAGE_SEARCH_TOOL.execute({ query: "missing orb phrase" })

    expect(result).toEqual({ ok: true, data: { matches: [] } })
    expect(authFetch).toHaveBeenCalledWith(expect.stringContaining(`sessionId=${encodeURIComponent(CURRENT_SESSION)}`), { method: "GET" })
  })

  it("is registered as the browser executor for the gateway manifest operation", () => {
    expect(findTool("talk_search_chat_messages")).toBe(CHAT_MESSAGE_SEARCH_TOOL)
  })
})
