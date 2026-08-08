import { beforeEach, describe, expect, it, vi } from "vitest"

const authFetch = vi.fn()

vi.mock("@/lib/auth", () => ({
  authFetch: (...args: unknown[]) => authFetch(...args),
}))

const { bindTalkActionLog, clearTalkActions, recordTalkAction, talkActions } = await import(
  "../talk-action-log"
)

const COMMENT = { tool: "comment_work_item", subject: "AAA-1", lane: "fast", consent: "not-required" } as const
const REFUSED = { tool: "update_work_item", subject: "AAA-2", lane: "consent", consent: "refused" } as const

function accepted(id: string) {
  return new Response(JSON.stringify({ id }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  })
}

beforeEach(() => {
  authFetch.mockReset()
  clearTalkActions()
})

describe("the talk action log", () => {
  it("records what a write touched, in which lane, and on whose consent", () => {
    const before = Date.now()
    const entry = recordTalkAction(COMMENT)

    expect(entry).toMatchObject(COMMENT)
    expect(entry.at).toBeGreaterThanOrEqual(before)
    expect(talkActions()).toEqual([entry])
  })

  it("records a refusal exactly like a write that happened — it is the one nothing else remembers", () => {
    recordTalkAction(REFUSED)

    expect(talkActions()).toHaveLength(1)
    expect(talkActions()[0]).toMatchObject({ lane: "consent", consent: "refused", subject: "AAA-2" })
  })

  it("names the entry a reversal undoes", () => {
    const entry = recordTalkAction({ ...COMMENT, undoOf: "act-1" })

    expect(entry.undoOf).toBe("act-1")
  })
})

describe("the durable half", () => {
  it("keeps the entry and posts nothing while the bench drives the tools", () => {
    recordTalkAction(COMMENT)

    expect(authFetch).not.toHaveBeenCalled()
    expect(talkActions()).toHaveLength(1)
  })

  it("posts to the bound session and takes the id the gateway hands back", async () => {
    authFetch.mockResolvedValue(accepted("act-9"))
    bindTalkActionLog("talk-1")

    const entry = recordTalkAction(COMMENT)

    await vi.waitFor(() => expect(entry.id).toBe("act-9"))
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/talk/sessions/talk-1/actions")
    expect(init.method).toBe("POST")
    expect(JSON.parse(String(init.body))).toEqual(COMMENT)
  })

  it("posts a refusal too, consent and all", async () => {
    authFetch.mockResolvedValue(accepted("act-10"))
    bindTalkActionLog("talk-1")

    recordTalkAction(REFUSED)

    await vi.waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1))
    const [, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual(REFUSED)
  })

  it("does not throw or lose the entry when the post never lands", async () => {
    authFetch.mockRejectedValue(new Error("offline"))
    bindTalkActionLog("talk-1")

    const entry = recordTalkAction(COMMENT)

    await vi.waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1))
    expect(talkActions()).toEqual([entry])
    expect(entry.id).toBeUndefined()
  })

  it("keeps the entry when the gateway turns the post down", async () => {
    authFetch.mockResolvedValue(new Response("no", { status: 500 }))
    bindTalkActionLog("talk-1")

    const entry = recordTalkAction(COMMENT)

    await vi.waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1))
    expect(talkActions()).toEqual([entry])
    expect(entry.id).toBeUndefined()
  })
})

describe("the in-memory log's ceiling", () => {
  it("keeps the newest attempts and drops the oldest", () => {
    for (let i = 0; i < 205; i += 1) recordTalkAction({ ...COMMENT, subject: `AAA-${i}` })

    const kept = talkActions()
    // The cap is a module constant rather than an export, so it is read off the
    // behaviour: whatever survives is a fixed-size tail of what was recorded.
    expect(kept).toHaveLength(200)
    expect(kept[kept.length - 1].subject).toBe("AAA-204")
    expect(kept[0].subject).toBe("AAA-5")
    expect(kept.some((entry) => entry.subject === "AAA-0")).toBe(false)
  })
})
