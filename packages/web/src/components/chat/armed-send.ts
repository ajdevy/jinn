export interface SendTapContext {
  isStop: boolean
  armed: boolean
  sttPending: boolean
  hasContent: boolean
}

export type SendTapAction = "stop" | "disarm" | "arm" | "send" | "noop"

/** Stop wins; otherwise a second tap disarms, pending STT arms, and visible
 * content sends. This is the pure core of the dictation send button. */
export function resolveSendTap(context: SendTapContext): SendTapAction {
  if (context.isStop) return "stop"
  if (context.armed) return "disarm"
  if (context.sttPending) return "arm"
  if (context.hasContent) return "send"
  return "noop"
}

export type TranscriptLandAction = "send" | "disarm" | "fill"

export function resolveTranscriptLanding(armed: boolean, transcript: string): TranscriptLandAction {
  if (!armed) return "fill"
  return transcript.trim().length > 0 ? "send" : "disarm"
}
