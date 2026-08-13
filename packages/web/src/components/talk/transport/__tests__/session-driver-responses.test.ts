/**
 * One utterance, one reply.
 *
 * The provider can put several tool calls in a single response, replay a call
 * the browser has already run, and — because the gateway configures server-side
 * VAD with `create_response` on — make a response of its own that the driver
 * never asked for. Every one of those used to end in an extra `response.create`,
 * which the operator hears as the orb answering twice and, for a write tool,
 * pays for as a duplicated action.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const authFetch = vi.fn()
vi.mock("@/lib/auth", () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }))

const addWorkItemComment = vi.fn()
vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>()
  return { ...original, api: { ...original.api, addWorkItemComment: (...args: unknown[]) => addWorkItemComment(...args) } }
})

const { createTalkDriver } = await import("../session-driver")

const RESPONSE_CREATED = JSON.stringify({ type: "response.created" })
const RESPONSE_DONE = JSON.stringify({ type: "response.done", response: {} })

function toolCall(callId: string) {
  return JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: callId,
    name: "talk_comment_todo",
    arguments: JSON.stringify({ id: "ABC-1", body: "on it" }),
  })
}

/** A driver with everything it sends recorded, split into the two things that
 *  matter here: the outputs it appends and the responses it asks for. */
function driver() {
  const sent: Array<Record<string, unknown>> = []
  const built = createTalkDriver({
    sessionId: "talk-1",
    send: (event) => sent.push(event),
    onState: () => {},
    onError: () => {},
  })
  const of = (type: string) => sent.filter((event) => event.type === type)
  return {
    driver: built,
    answers: () => of("conversation.item.create").map((event) => (event.item as { call_id: string }).call_id),
    requests: () => of("response.create"),
  }
}

/** Let every pending tool settle, so "nothing else happened" is a fact about a
 *  drained queue rather than about a promise nobody waited for. */
async function settle() {
  for (let tick = 0; tick < 4; tick += 1) await Promise.resolve()
}

beforeEach(() => {
  authFetch.mockReset()
  authFetch.mockResolvedValue(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }))
  addWorkItemComment.mockReset()
  addWorkItemComment.mockResolvedValue({ comment: { id: "c-1" } })
})

describe("asking for a response after a tool call", () => {
  it("answers both calls of one turn and then asks for a single response", async () => {
    const talk = driver()

    talk.driver.receive(toolCall("call-1"))
    talk.driver.receive(toolCall("call-2"))

    await vi.waitFor(() => expect(talk.answers()).toHaveLength(2))
    expect([...talk.answers()].sort()).toEqual(["call-1", "call-2"])
    expect(talk.requests()).toHaveLength(1)
  })

  it("asks straight away when nothing is speaking", async () => {
    const talk = driver()

    talk.driver.receive(toolCall("call-1"))

    await vi.waitFor(() => expect(talk.requests()).toHaveLength(1))
    expect(talk.answers()).toEqual(["call-1"])
  })

  it("runs a call_id the provider replays exactly once", async () => {
    const talk = driver()
    talk.driver.receive(toolCall("call-1"))
    await vi.waitFor(() => expect(talk.answers()).toHaveLength(1))

    talk.driver.receive(toolCall("call-1"))
    await settle()

    // The tool's own effect, not the count of frames sent: a second write that
    // was answered with one output would still be a second comment on the Todo.
    expect(addWorkItemComment).toHaveBeenCalledTimes(1)
    expect(talk.answers()).toEqual(["call-1"])
    expect(talk.requests()).toHaveLength(1)
  })
})

describe("a response already in flight", () => {
  it("holds its request while the assistant is still speaking, then makes it once", async () => {
    const talk = driver()

    talk.driver.receive(RESPONSE_CREATED)
    talk.driver.receive(toolCall("call-1"))
    await vi.waitFor(() => expect(talk.answers()).toHaveLength(1))

    // Asking now would be refused as `conversation_already_has_active_response`
    // — and dropping the ask instead would leave the tool's result unspoken.
    expect(talk.requests()).toHaveLength(0)
    talk.driver.receive(RESPONSE_DONE)
    expect(talk.requests()).toHaveLength(1)
  })

  it("adds one request to a VAD turn that finished before the tool did", async () => {
    let finishComment: (value: unknown) => void = () => {}
    addWorkItemComment.mockReturnValue(
      new Promise((resolve) => {
        finishComment = resolve
      }),
    )
    const talk = driver()

    // The provider's own response: created without the driver asking, carrying
    // the tool call, and done speaking before the browser has run it.
    talk.driver.receive(RESPONSE_CREATED)
    talk.driver.receive(toolCall("call-1"))
    talk.driver.receive(RESPONSE_DONE)
    expect(talk.requests()).toHaveLength(0)
    finishComment({ comment: { id: "c-1" } })

    await vi.waitFor(() => expect(talk.answers()).toHaveLength(1))
    await settle()
    expect(talk.requests()).toHaveLength(1)
  })

  it("makes one request across the whole exchange, not one per response", async () => {
    const talk = driver()

    talk.driver.receive(RESPONSE_CREATED)
    talk.driver.receive(toolCall("call-1"))
    await vi.waitFor(() => expect(talk.answers()).toHaveLength(1))
    talk.driver.receive(RESPONSE_DONE)
    talk.driver.receive(RESPONSE_CREATED)
    talk.driver.receive(RESPONSE_DONE)
    await settle()

    expect(talk.requests()).toHaveLength(1)
  })
})
