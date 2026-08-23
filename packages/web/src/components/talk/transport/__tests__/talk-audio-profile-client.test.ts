import { beforeEach, describe, expect, it, vi } from "vitest"

const authFetch = vi.fn()
vi.mock("@/lib/auth", () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }))

const { openTalkSession, resumeTalkSession } = await import("../session-client")

const MANIFEST = {
  version: 1,
  operations: [{
    name: "read_todo",
    description: "Read one Todo.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    target: "gateway",
    intent: "todos",
    mutability: "read",
    operatorOnly: false,
    verification: "todo-reread",
  }],
} as const

const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "Content-Type": "application/json" },
})

beforeEach(() => {
  authFetch.mockReset()
  localStorage.clear()
})

describe("persisted Talk audio profile", () => {
  it("mints a new session against a close microphone", async () => {
    localStorage.setItem("jinn-settings", JSON.stringify({ talkMicrophone: "near_field" }))
    authFetch.mockResolvedValue(json({ id: "talk-1", token: "secret", manifest: MANIFEST }))

    await openTalkSession()

    const [, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({ noiseReduction: "near_field" })
  })

  it("falls back to far-field when stored microphone data is invalid", async () => {
    localStorage.setItem("jinn-settings", JSON.stringify({ talkMicrophone: "studio" }))
    authFetch.mockResolvedValue(json({ id: "talk-1", token: "secret", manifest: MANIFEST }))

    await openTalkSession()

    const [, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({ noiseReduction: "far_field" })
  })

  it("re-mints a resumed session against the current profile", async () => {
    localStorage.setItem("jinn-settings", JSON.stringify({ talkMicrophone: "near_field" }))
    authFetch.mockResolvedValue(json({ token: "fresh", expiresAt: 99 }))

    await resumeTalkSession("talk-1")

    const [, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ noiseReduction: "near_field" })
  })
})
