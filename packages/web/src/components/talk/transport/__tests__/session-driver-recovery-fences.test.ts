import { beforeEach, describe, expect, it, vi } from "vitest"
import type { InterruptionTelemetry } from "../false-start-recovery"

const authFetch = vi.fn()
vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>()
  return { ...original, authFetch: (...args: unknown[]) => authFetch(...args) }
})

const { createTalkDriver } = await import("../session-driver")
const { browserControlFixture } = await import("./control-fixture")

const frame = (type: string, fields: Record<string, unknown> = {}) => JSON.stringify({ type, ...fields })
const created = (id: string) => frame("response.created", { response: { id } })
const started = (item: string, at: number) => frame("input_audio_buffer.speech_started", {
  item_id: item,
  audio_start_ms: at,
})
const stopped = (item: string, at: number) => frame("input_audio_buffer.speech_stopped", {
  item_id: item,
  audio_end_ms: at,
})
const cleared = (id: string) => frame("output_audio_buffer.cleared", { response_id: id })
const transcript = (item: string, text = "") => frame("conversation.item.input_audio_transcription.completed", {
  item_id: item,
  event_id: `event-${item}`,
  transcript: text,
})
const cancelled = (id: string) => frame("response.done", {
  response: { id, status: "cancelled", status_details: { reason: "turn_detected" } },
})

function harness() {
  const sent: Array<Record<string, unknown>> = []
  const interruptions: InterruptionTelemetry[] = []
  const driver = createTalkDriver({
    sessionId: "talk-fences",
    manifest: browserControlFixture(),
    send: (event) => { sent.push(event) },
    onState: () => {},
    onError: () => {},
    onInterruption: (event) => { interruptions.push(event) },
  })
  return {
    driver,
    requests: () => sent.filter((event) => event.type === "response.create"),
    outputs: () => sent.filter((event) => event.type === "conversation.item.create"),
    interruptions,
  }
}

beforeEach(() => {
  authFetch.mockReset()
  authFetch.mockResolvedValue(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }))
})

describe("false-start recovery fences", () => {
  it("cannot reopen a response after a newer speech item disqualifies it", () => {
    const talk = harness()
    talk.driver.receive(created("response-1"))
    talk.driver.receive(started("item-1", 1_000))
    talk.driver.receive(started("item-2", 1_100))
    talk.driver.receive(cancelled("response-1"))
    talk.driver.receive(cleared("response-1"))
    talk.driver.receive(stopped("item-2", 1_300))
    talk.driver.receive(transcript("item-2"))

    expect(talk.requests()).toHaveLength(0)
    expect(talk.interruptions).toEqual([expect.objectContaining({ recovered: false })])
  })

  it("cannot reopen a response after its tool has settled", async () => {
    const talk = harness()
    talk.driver.receive(created("response-1"))
    talk.driver.receive(frame("response.function_call_arguments.done", {
      call_id: "call-1",
      name: "list_todos",
      arguments: "{}",
    }))
    await vi.waitFor(() => expect(talk.outputs()).toHaveLength(1))
    talk.driver.receive(started("item-1", 1_000))
    talk.driver.receive(cancelled("response-1"))
    talk.driver.receive(cleared("response-1"))
    talk.driver.receive(stopped("item-1", 1_200))
    talk.driver.receive(transcript("item-1"))

    expect(talk.requests()).toHaveLength(0)
    expect(talk.interruptions).toEqual([])
  })

  it("stays terminal after stop even if provider frames arrive late", () => {
    const talk = harness()
    talk.driver.receive(created("response-1"))
    talk.driver.receive(started("item-1", 1_000))
    talk.driver.stop()
    talk.driver.receive(created("response-2"))
    talk.driver.receive(started("item-2", 2_000))
    talk.driver.receive(cancelled("response-2"))
    talk.driver.receive(cleared("response-2"))
    talk.driver.receive(stopped("item-2", 2_200))
    talk.driver.receive(transcript("item-2"))

    expect(talk.requests()).toHaveLength(0)
  })

  it("does not reuse a playback id after the provider clears it", () => {
    const talk = harness()
    talk.driver.receive(created("response-1"))
    talk.driver.receive(frame("output_audio_buffer.started", { response_id: "response-1" }))
    talk.driver.receive(frame("response.done", { response: { id: "response-1", status: "completed" } }))
    talk.driver.receive(started("item-1", 1_000))
    talk.driver.receive(cleared("response-1"))
    talk.driver.receive(stopped("item-1", 1_200))
    talk.driver.receive(transcript("item-1"))

    talk.driver.receive(started("item-2", 2_000))
    talk.driver.receive(cleared("response-1"))
    talk.driver.receive(stopped("item-2", 2_200))
    talk.driver.receive(transcript("item-2"))

    expect(talk.requests()).toHaveLength(1)
    expect(talk.interruptions).toHaveLength(1)
  })
})
