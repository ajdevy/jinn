/**
 * How OpenAI's `response.done` token counts fold into {@link RealtimeUsage}.
 *
 * Split out of ./openai.ts, which is about the socket. Attribution lives here
 * because deciding which bucket a token lands in is a billing call, not a
 * protocol one.
 */
import type { RealtimeUsage } from "../../shared/types.js";
import { dearerCachedModality } from "../session/pricing.js";

/** `cached_tokens` counts the whole cached prefix and `cached_tokens_details`
 *  breaks it down by modality; both are subsets of the counts beside them. */
interface OpenAiInputTokens {
  text_tokens?: number;
  audio_tokens?: number;
  cached_tokens?: number;
  cached_tokens_details?: { text_tokens?: number; audio_tokens?: number };
}

/** Shape of `response.usage` on a `response.done` event. */
export interface OpenAiUsage {
  input_token_details?: OpenAiInputTokens;
  output_token_details?: { text_tokens?: number; audio_tokens?: number };
}

export function emptyUsage(): RealtimeUsage {
  return {
    inputAudioTokens: 0,
    outputAudioTokens: 0,
    inputTextTokens: 0,
    outputTextTokens: 0,
    cachedInputAudioTokens: 0,
    cachedInputTextTokens: 0,
  };
}

/**
 * Split one response's cached prefix across the two priced modalities.
 *
 * `cached_tokens` is always reported; the breakdown is a refinement the server
 * may omit. Whatever the breakdown leaves unattributed goes to the dearer cached
 * rate, because an over-report shows up in the cost line and an under-report is
 * the kind of wrong nobody notices.
 */
function cachedByModality(input: OpenAiInputTokens, model: string): { audio: number; text: number } {
  const audio = input.cached_tokens_details?.audio_tokens ?? 0;
  const text = input.cached_tokens_details?.text_tokens ?? 0;
  const unattributed = Math.max(0, (input.cached_tokens ?? 0) - audio - text);
  if (dearerCachedModality(model) === "text") return { audio, text: text + unattributed };
  return { audio: audio + unattributed, text };
}

/** Add one response's counts to a session's running total. `model` decides only
 *  where cached tokens the server did not attribute land. */
export function addUsage(total: RealtimeUsage, usage: OpenAiUsage, model: string): void {
  const input = usage.input_token_details ?? {};
  const output = usage.output_token_details ?? {};
  const cached = cachedByModality(input, model);
  total.inputAudioTokens += input.audio_tokens ?? 0;
  total.inputTextTokens += input.text_tokens ?? 0;
  total.cachedInputAudioTokens += cached.audio;
  total.cachedInputTextTokens += cached.text;
  total.outputAudioTokens += output.audio_tokens ?? 0;
  total.outputTextTokens += output.text_tokens ?? 0;
}
