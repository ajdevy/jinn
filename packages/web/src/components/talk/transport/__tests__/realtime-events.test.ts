import { describe, expect, it } from "vitest"
import { createFrameReader } from "../realtime-events"

/** One frame through a reader of its own, for the cases where no total carries. */
function frame(event: unknown) {
  return createFrameReader()(JSON.stringify(event))
}

function responseDone(usage: unknown) {
  return JSON.stringify({ type: "response.done", response: { usage } })
}

describe("createFrameReader", () => {
  it("reads a finished tool call, arguments left as the raw JSON the model wrote", () => {
    expect(
      frame({
        type: "response.function_call_arguments.done",
        event_id: "event-call-1",
        item_id: "item-call-1",
        call_id: "call-1",
        name: "open_todo",
        arguments: '{"id":"ABC-1"}',
      }),
    ).toEqual({
      type: "tool_call",
      eventId: "event-call-1",
      itemId: "item-call-1",
      callId: "call-1",
      name: "open_todo",
      arguments: '{"id":"ABC-1"}',
    })
  })

  it("carries the session total after the turn, adding up counts reported per response", () => {
    const read = createFrameReader()

    read(responseDone({ input_token_details: { audio_tokens: 900 }, output_token_details: { audio_tokens: 400 } }))
    const second = read(
      responseDone({ input_token_details: { audio_tokens: 600 }, output_token_details: { audio_tokens: 250 } }),
    )

    expect(second).toMatchObject({ type: "turn_done", usage: { inputAudioTokens: 1500, outputAudioTokens: 650 } })
  })

  it("reads the turn's usage off response.done", () => {
    const parsed = frame({
      type: "response.done",
      response: {
        usage: {
          input_token_details: { audio_tokens: 900, text_tokens: 120, cached_tokens: 700 },
          output_token_details: { audio_tokens: 400, text_tokens: 30 },
        },
      },
    })

    expect(parsed).toEqual({
      type: "turn_done",
      usage: {
        inputAudioTokens: 900,
        outputAudioTokens: 400,
        inputTextTokens: 120,
        outputTextTokens: 30,
        cachedInputAudioTokens: 0,
        cachedInputTextTokens: 0,
        inputImageTokens: 0,
        cachedInputImageTokens: 0,
      },
    })
  })

  it("attributes image input and cached image tokens", () => {
    const parsed = frame({
      type: "response.done",
      response: {
        usage: {
          input_token_details: {
            image_tokens: 765,
            cached_tokens_details: { image_tokens: 100 },
          },
        },
      },
    })

    expect(parsed).toEqual({
      type: "turn_done",
      usage: expect.objectContaining({ inputImageTokens: 765, cachedInputImageTokens: 100 }),
    })
  })

  it("counts a cached token only where the provider split it by modality", () => {
    const parsed = frame({
      type: "response.done",
      response: {
        usage: {
          input_token_details: {
            audio_tokens: 900,
            text_tokens: 120,
            cached_tokens: 700,
            cached_tokens_details: { audio_tokens: 600, text_tokens: 40 },
          },
        },
      },
    })

    expect(parsed).toMatchObject({
      usage: { cachedInputAudioTokens: 600, cachedInputTextTokens: 40 },
    })
  })

  it("reports a turn with no usage at all as zeroes rather than dropping the turn", () => {
    expect(frame({ type: "response.done", response: {} })).toMatchObject({
      type: "turn_done",
      usage: { inputAudioTokens: 0, outputAudioTokens: 0 },
    })
  })

  it("reads both halves of the transcript, and which of them is final", () => {
    expect(frame({ type: "response.output_audio_transcript.delta", delta: "on it" })).toEqual({
      type: "transcript",
      role: "assistant",
      text: "on it",
      final: false,
    })
    expect(frame({ type: "response.output_audio_transcript.done", transcript: "on it, opening ABC-1" })).toEqual({
      type: "transcript",
      role: "assistant",
      text: "on it, opening ABC-1",
      final: true,
    })
    expect(
      frame({
        type: "conversation.item.input_audio_transcription.completed",
        event_id: "event-user-1",
        item_id: "item-user-1",
        transcript: "open ABC-1",
      }),
    ).toEqual({
      type: "transcript",
      role: "user",
      text: "open ABC-1",
      final: true,
      eventId: "event-user-1",
      itemId: "item-user-1",
    })
  })

  it("preserves provider acknowledgement identity for a created conversation item", () => {
    expect(frame({
      type: "conversation.item.created",
      event_id: "event-created-1",
      previous_item_id: "item-user-1",
      item: { id: "item-image-1", type: "message" },
    })).toEqual({
      type: "item_created",
      eventId: "event-created-1",
      itemId: "item-image-1",
      previousItemId: "item-user-1",
    })
  })

  it("reads the two ends of an assistant response", () => {
    expect(frame({ type: "response.created" })).toEqual({ type: "turn_started" })
    expect(frame({ type: "response.done", response: {} })).toMatchObject({ type: "turn_done" })
  })

  it("reads the two ends of a spoken turn", () => {
    expect(frame({ type: "input_audio_buffer.speech_started" })).toEqual({ type: "speech_started" })
    expect(frame({ type: "input_audio_buffer.speech_stopped" })).toEqual({ type: "speech_stopped" })
  })

  it("carries the provider's own words on an error", () => {
    expect(frame({ type: "error", error: { message: "session expired" } })).toEqual({
      type: "error",
      message: "session expired",
    })
  })

  it("names an error the provider left unexplained rather than reporting an empty one", () => {
    expect(frame({ type: "error", error: {} })).toEqual({
      type: "error",
      message: "The realtime provider reported an error with no message.",
    })
  })

  it("ignores the frames the orb has no use for, and a frame that is not JSON", () => {
    expect(frame({ type: "response.output_item.added" })).toBeNull()
    expect(createFrameReader()("not json")).toBeNull()
    expect(createFrameReader()("[]")).toBeNull()
  })
})
