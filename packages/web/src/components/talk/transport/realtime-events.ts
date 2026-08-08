/**
 * One `oai-events` data-channel frame in, one thing the orb acts on out.
 *
 * The provider speaks far more events than a voice orb needs, so this narrows
 * them to the six the transport can do something about and drops the rest. It
 * is the same translation the gateway's own adapter does over its WebSocket
 * (`talk/realtime/openai.ts`), which is why the vocabulary matches: two surfaces
 * reading one provider should not describe it differently.
 */
import { addTalkUsage, emptyTalkUsage, type TalkUsage } from "./usage-delta"

export type RealtimeFrame =
  | { type: "tool_call"; callId: string; name: string; arguments: string }
  /** The assistant turn finished. `usage` is the session total after it. */
  | { type: "turn_done"; usage: TalkUsage }
  | { type: "transcript"; role: "assistant" | "user"; text: string; final: boolean }
  /** The provider's voice-activity detector heard the operator start talking. */
  | { type: "speech_started" }
  | { type: "speech_stopped" }
  | { type: "error"; message: string }

interface TokenDetails {
  audio_tokens?: number
  text_tokens?: number
  cached_tokens_details?: { audio_tokens?: number; text_tokens?: number }
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * One response's own token counts, in the shape `POST .../turn` accepts.
 *
 * `response.usage` on a `response.done` event counts the response that just
 * finished, not the session to date — which is why the reader below adds it to
 * a running total rather than reporting it as one.
 *
 * Only the cached tokens the provider actually attributed to a modality are
 * reported as cached. A cached count the provider left unsplit is left out, so
 * those tokens bill at the full input rate — an over-report that shows up in
 * the cost line, rather than an under-report nobody notices. Splitting them
 * properly needs the rate table, which lives in the gateway and has no business
 * being copied into a browser bundle.
 */
function readResponseUsage(raw: unknown): TalkUsage {
  const usage = (raw ?? {}) as { input_token_details?: TokenDetails; output_token_details?: TokenDetails }
  const input = usage.input_token_details ?? {}
  const output = usage.output_token_details ?? {}
  return {
    ...emptyTalkUsage(),
    inputAudioTokens: count(input.audio_tokens),
    inputTextTokens: count(input.text_tokens),
    outputAudioTokens: count(output.audio_tokens),
    outputTextTokens: count(output.text_tokens),
    cachedInputAudioTokens: count(input.cached_tokens_details?.audio_tokens),
    cachedInputTextTokens: count(input.cached_tokens_details?.text_tokens),
  }
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message
  }
  return "The realtime provider reported an error with no message."
}

type FrameReader = (event: Record<string, unknown>) => RealtimeFrame

/** The provider's event names, mapped to what the orb does about them. A table
 *  rather than a switch so a seventh event is one line and no new branch.
 *  `response.done` is not in it: that is the one frame needing the session's
 *  running total, which a table of pure readers has nowhere to keep. */
const READERS: Readonly<Record<string, FrameReader>> = {
  "response.function_call_arguments.done": (event) => ({
    type: "tool_call",
    callId: String(event.call_id),
    name: String(event.name),
    arguments: String(event.arguments ?? ""),
  }),
  "response.output_audio_transcript.delta": (event) => ({
    type: "transcript",
    role: "assistant",
    text: String(event.delta ?? ""),
    final: false,
  }),
  "response.output_audio_transcript.done": (event) => ({
    type: "transcript",
    role: "assistant",
    text: String(event.transcript ?? ""),
    final: true,
  }),
  "conversation.item.input_audio_transcription.completed": (event) => ({
    type: "transcript",
    role: "user",
    text: String(event.transcript ?? ""),
    final: true,
  }),
  "input_audio_buffer.speech_started": () => ({ type: "speech_started" }),
  "input_audio_buffer.speech_stopped": () => ({ type: "speech_stopped" }),
  error: (event) => ({ type: "error", message: errorMessage(event.error) }),
}

function parseEvent(data: string): Record<string, unknown> | null {
  let event: unknown
  try {
    event = JSON.parse(data)
  } catch {
    return null
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) return null
  return event as Record<string, unknown>
}

/**
 * A reader for one conversation's frames.
 *
 * It remembers one thing, and only because the provider makes it: `response.done`
 * reports the counts of the response that just finished, while a `turn_done`
 * frame carries the session total after that turn (shared/voice.ts). Adding them
 * up here is what the gateway's adapter does over its own socket, and it is what
 * lets the transport bill a turn by subtracting the reading before it.
 *
 * It returns null for a frame the transport has no use for, including one that
 * is not JSON at all — a malformed frame must not take a live session down.
 */
export function createFrameReader(): (data: string) => RealtimeFrame | null {
  let total = emptyTalkUsage()
  return (data) => {
    const event = parseEvent(data)
    if (!event || typeof event.type !== "string") return null
    if (event.type === "response.done") {
      const response = (event.response as { usage?: unknown } | undefined)?.usage
      total = addTalkUsage(total, readResponseUsage(response))
      return { type: "turn_done", usage: total }
    }
    const read = READERS[event.type]
    return read ? read(event) : null
  }
}
