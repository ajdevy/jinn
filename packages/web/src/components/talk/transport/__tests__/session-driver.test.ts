import { beforeEach, describe, expect, it, vi } from "vitest"

const authFetch = vi.fn()
vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>()
  return { ...original, authFetch: (...args: unknown[]) => authFetch(...args) }
})

const addWorkItemComment = vi.fn()
vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>()
  return { ...original, api: { ...original.api, addWorkItemComment: (...args: unknown[]) => addWorkItemComment(...args) } }
})

const { createTalkDriver } = await import("../session-driver")
const { findTool, toolDefinitions } = await import("@/components/talk/tools/registry")
const { bindTalkActionLog, clearTalkActions } = await import("@/components/talk/talk-action-log")
const { browserControlFixture } = await import("./control-fixture")

function accepted(body: unknown = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
}

function turnDone(usage: Record<string, number>) {
  return JSON.stringify({
    type: "response.done",
    response: {
      usage: {
        input_token_details: { audio_tokens: usage.inputAudio ?? 0, text_tokens: usage.inputText ?? 0 },
        output_token_details: { audio_tokens: usage.outputAudio ?? 0, text_tokens: 0 },
      },
    },
  })
}

function driver(overrides: { onState?: (state: string) => void; onError?: (message: string) => void } = {}) {
  const sent: Array<Record<string, unknown>> = []
  const built = createTalkDriver({
    sessionId: "talk-1",
    manifest: browserControlFixture(),
    send: (event) => sent.push(event),
    onState: overrides.onState ?? (() => {}),
    onError: overrides.onError ?? (() => {}),
  })
  return { sent, driver: built }
}

/** What the registry declares for one tool, minus its name. */
function toolShape(name: string) {
  const definition = toolDefinitions().find((tool) => tool.name === name)!
  return { description: definition.description, parameters: definition.parameters }
}

/** The bodies of every `/turn` post, in order. */
function turnBodies() {
  return authFetch.mock.calls
    .filter(([url]) => String(url).endsWith("/turn"))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { usage: Record<string, number> })
}

beforeEach(() => {
  authFetch.mockReset()
  authFetch.mockResolvedValue(accepted())
  addWorkItemComment.mockReset()
  clearTalkActions()
})

describe("declaring the tool catalog", () => {
  it("sends exactly one session.update when the channel opens", () => {
    const { sent, driver: talk } = driver()

    talk.start()

    expect(sent).toHaveLength(1)
    expect(sent[0]!.type).toBe("session.update")
  })

  it("declares exactly the manifest fixture and keeps each browser target executable", () => {
    const { sent, driver: talk } = driver()

    talk.start()

    const session = sent[0]!.session as { tools: Array<{ name: string; description: string; parameters: unknown }> }
    const declared = session.tools.map((tool) => tool.name)
    expect(declared).toEqual(toolDefinitions().map((tool) => tool.name))
    for (const tool of session.tools) {
      // A name the registry cannot resolve is a tool the model can call and the
      // browser can only apologise for.
      expect(findTool(tool.name)).toBeDefined()
      expect(tool).toMatchObject(toolShape(tool.name))
    }
  })
})

describe("running a tool the model called", () => {
  it("logs the write to the bound session and answers the model with the result", async () => {
    bindTalkActionLog("talk-1")
    addWorkItemComment.mockResolvedValue({ comment: { id: "c-1" } })
    const { sent, driver: talk } = driver()

    talk.receive(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "call-1",
        name: "talk_comment_todo",
        arguments: JSON.stringify({ id: "ABC-1", body: "on it" }),
      }),
    )

    await vi.waitFor(() => expect(sent.some((event) => event.type === "conversation.item.create")).toBe(true))
    const answer = sent.find((event) => event.type === "conversation.item.create")!
    const item = answer.item as { call_id: string; output: string; type: string }
    expect(item).toMatchObject({ type: "function_call_output", call_id: "call-1" })
    expect(JSON.parse(item.output)).toMatchObject({ ok: true })
    expect(sent.some((event) => event.type === "response.create")).toBe(true)

    await vi.waitFor(() =>
      expect(authFetch.mock.calls.some(([url]) => url === "/api/talk/sessions/talk-1/actions")).toBe(true),
    )
  })

  it("answers a tool the registry does not have instead of leaving the model waiting", async () => {
    const { sent, driver: talk } = driver()

    talk.receive(
      JSON.stringify({ type: "response.function_call_arguments.done", call_id: "call-2", name: "nope", arguments: "{}" }),
    )

    await vi.waitFor(() => expect(sent.some((event) => event.type === "conversation.item.create")).toBe(true))
    const item = sent.find((event) => event.type === "conversation.item.create")!.item as { output: string }
    expect(JSON.parse(item.output)).toMatchObject({ ok: false })
  })
})

describe("what a turn costs", () => {
  it("posts what each response cost, never the running total it took the session to", async () => {
    const { driver: talk } = driver()

    // `response.usage` counts one response, so a cheaper second turn is a
    // smaller number and not a lower total. Posting it as a total would bill
    // the first turn twice; subtracting it from one would bill it as nothing.
    talk.receive(turnDone({ inputAudio: 900, outputAudio: 400 }))
    await vi.waitFor(() => expect(turnBodies()).toHaveLength(1))
    talk.receive(turnDone({ inputAudio: 600, outputAudio: 250 }))
    await vi.waitFor(() => expect(turnBodies()).toHaveLength(2))

    const [first, second] = turnBodies()
    expect(first!.usage).toMatchObject({ inputAudioTokens: 900, outputAudioTokens: 400 })
    expect(second!.usage).toMatchObject({ inputAudioTokens: 600, outputAudioTokens: 250 })
  })

  it("sends what was said with the turn it was said in", async () => {
    const { driver: talk } = driver()

    talk.receive(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: "opening ABC-1" }))
    talk.receive(turnDone({ inputAudio: 10 }))

    await vi.waitFor(() => expect(turnBodies()).toHaveLength(1))
    const [, init] = authFetch.mock.calls.find(([url]) => String(url).endsWith("/turn")) as [string, RequestInit]
    expect(JSON.parse(String(init.body)).transcript).toBe("opening ABC-1")
  })

  it("posts the provider response identity with the durable assistant turn", async () => {
    const { driver: talk } = driver()

    talk.receive(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: "opening ABC-1" }))
    talk.receive(JSON.stringify({
      type: "response.done",
      response: {
        id: "response-1",
        output: [{ id: "assistant-item-1", type: "message" }],
        usage: {},
      },
    }))

    await vi.waitFor(() => expect(turnBodies()).toHaveLength(1))
    const [, init] = authFetch.mock.calls.find(([url]) => String(url).endsWith("/turn")) as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({
      providerResponseId: "response-1",
      providerItemId: "assistant-item-1",
    })
  })

  it("does not repeat the last thing said on the next turn", async () => {
    const { driver: talk } = driver()

    talk.receive(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: "opening ABC-1" }))
    talk.receive(turnDone({ inputAudio: 10 }))
    await vi.waitFor(() => expect(turnBodies()).toHaveLength(1))
    talk.receive(turnDone({ inputAudio: 20 }))
    await vi.waitFor(() => expect(turnBodies()).toHaveLength(2))

    const bodies = authFetch.mock.calls
      .filter(([url]) => String(url).endsWith("/turn"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { transcript: string })
    expect(bodies[1]!.transcript).toBe("")
  })
})

describe("what the orb shows", () => {
  it("moves through thinking and speaking and back, reporting only what changed", () => {
    const states: string[] = []
    const { driver: talk } = driver({ onState: (state) => states.push(state) })

    // A live session is already listening, so the first frame reports nothing —
    // and two transcript deltas are one stretch of speaking, not two.
    talk.receive(JSON.stringify({ type: "input_audio_buffer.speech_started" }))
    talk.receive(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }))
    talk.receive(JSON.stringify({ type: "response.output_audio_transcript.delta", delta: "on " }))
    talk.receive(JSON.stringify({ type: "response.output_audio_transcript.delta", delta: "it" }))
    talk.receive(turnDone({}))

    expect(states).toEqual(["thinking", "speaking", "listening"])
  })

  it("stays quiet about the operator's own transcript, which is not the orb talking", () => {
    const states: string[] = []
    const { driver: talk } = driver({ onState: (state) => states.push(state) })

    talk.receive(
      JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "open ABC-1" }),
    )

    expect(states).toEqual([])
  })

  it("passes a provider error on in the provider's own words", () => {
    const errors: string[] = []
    const { driver: talk } = driver({ onError: (message) => errors.push(message) })

    talk.receive(JSON.stringify({ type: "error", error: { message: "session expired" } }))

    expect(errors).toEqual(["session expired"])
  })
})
