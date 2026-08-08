/**
 * Token counts, and the one subtraction that keeps a voice session honestly
 * billed.
 *
 * The provider reports a session's usage as a running total, while
 * `POST /api/talk/sessions/:id/turn` prices whatever it is handed as that turn
 * alone (docs/talk-session-runtime.md). Posting a total where a delta belongs
 * bills every earlier turn again, and the over-charge compounds with the
 * conversation. So the subtraction lives here rather than inline in the
 * transport: one place to read, and one place to get wrong.
 */

/** Structurally the gateway's `RealtimeUsage` (packages/jinn/src/shared/voice.ts).
 *  The web package has no import path into the gateway, so it is declared here,
 *  as `tool-spec.ts` does for `RealtimeTool`. */
export interface TalkUsage {
  inputAudioTokens: number
  outputAudioTokens: number
  inputTextTokens: number
  outputTextTokens: number
  cachedInputAudioTokens: number
  cachedInputTextTokens: number
}

const USAGE_KEYS: readonly (keyof TalkUsage)[] = [
  "inputAudioTokens",
  "outputAudioTokens",
  "inputTextTokens",
  "outputTextTokens",
  "cachedInputAudioTokens",
  "cachedInputTextTokens",
]

export function emptyTalkUsage(): TalkUsage {
  return {
    inputAudioTokens: 0,
    outputAudioTokens: 0,
    inputTextTokens: 0,
    outputTextTokens: 0,
    cachedInputAudioTokens: 0,
    cachedInputTextTokens: 0,
  }
}

/**
 * What this turn added, from the session totals before it and after it.
 *
 * A count that came back lower than the previous reading clamps to zero rather
 * than posting negative: the gateway rejects any negative token count with a
 * 400, and a provider quirk in the accounting must not fail a live turn.
 */
export function usageDelta(previous: TalkUsage, total: TalkUsage): TalkUsage {
  const delta = emptyTalkUsage()
  for (const key of USAGE_KEYS) delta[key] = Math.max(0, total[key] - previous[key])
  return delta
}
