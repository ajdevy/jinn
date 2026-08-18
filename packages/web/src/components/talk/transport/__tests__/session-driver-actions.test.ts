import { beforeEach, describe, expect, it, vi } from "vitest"

const authFetch = vi.fn()
vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>()
  return { ...original, authFetch: (...args: unknown[]) => authFetch(...args) }
})

const localExecute = vi.fn()
vi.mock("@/components/talk/tools/registry", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/talk/tools/registry")>()
  return { ...original, executeToolCall: (...args: unknown[]) => localExecute(...args) }
})

const { createTalkDriver } = await import("../session-driver")

const operation = {
  name: "talk_comment_todo",
  description: "Add one verified comment.",
  parameters: {
    type: "object" as const,
    properties: { id: { type: "string" }, body: { type: "string" } },
    required: ["id", "body"],
    additionalProperties: false as const,
  },
  target: "gateway" as const,
  exposure: "always" as const,
  intent: "todos",
  mutability: "write" as const,
  operatorOnly: true,
  verification: "comment-reread",
}

function response(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
}

beforeEach(() => {
  authFetch.mockReset()
  localExecute.mockReset()
})

describe("gateway-target Talk controls", () => {
  it("routes through the gateway, applies a verified UI effect, and never runs the browser executor", async () => {
    const applyUiEffect = vi.fn().mockResolvedValue(undefined)
    authFetch.mockResolvedValue(response({
      ok: true,
      verified: true,
      receiptId: "receipt-1",
      replayed: false,
      operation: operation.name,
      data: { commentId: "comment-1" },
      evidence: { id: "comment-1" },
      uiEffect: { invalidate: ["todo:ABC-1"], navigate: "/todos/ABC-1" },
    }))
    const sent: Array<Record<string, unknown>> = []
    const driver = createTalkDriver({
      sessionId: "talk-1",
      manifest: { version: 1, operations: [operation] },
      send: (event) => sent.push(event),
      onState: () => {},
      onError: () => {},
      applyUiEffect,
    })

    driver.receive(JSON.stringify({
      type: "response.function_call_arguments.done",
      event_id: "event-1",
      item_id: "item-1",
      call_id: "call-1",
      name: operation.name,
      arguments: '{"id":"ABC-1","body":"done"}',
    }))

    await vi.waitFor(() => expect(applyUiEffect).toHaveBeenCalledOnce())
    expect(localExecute).not.toHaveBeenCalled()
    expect(authFetch).toHaveBeenCalledTimes(1)
    const [, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({ providerCallId: "call-1", providerItemId: "item-1", tool: operation.name })
    const output = sent.find((event) => event.type === "conversation.item.create")!.item as { output: string }
    expect(JSON.parse(output.output)).toMatchObject({ ok: true, verified: true, receiptId: "receipt-1" })
  })

  it("does not apply an unverified effect", async () => {
    const applyUiEffect = vi.fn()
    authFetch.mockResolvedValue(response({ ok: false, code: "verification-failed", error: "No evidence." }))
    const driver = createTalkDriver({
      sessionId: "talk-1",
      manifest: { version: 1, operations: [operation] },
      send: () => {},
      onState: () => {},
      onError: () => {},
      applyUiEffect,
    })
    driver.receive(JSON.stringify({ type: "response.function_call_arguments.done", call_id: "call-2", name: operation.name, arguments: "{}" }))
    await vi.waitFor(() => expect(authFetch).toHaveBeenCalledOnce())
    expect(applyUiEffect).not.toHaveBeenCalled()
  })
})
