import type { RealtimeFrame } from "./realtime-events"
import { postTalkTranscript } from "./session-client"

export interface OperatorTranscriptEvidence {
  itemId: string
  eventId: string
  persisted: Promise<void>
}

interface TranscriptSession {
  sessionId: string
  browserInstanceId?: string
  credentialGeneration?: number
}

export function persistOperatorTranscript(
  frame: Extract<RealtimeFrame, { type: "transcript" }>,
  session: TranscriptSession,
): OperatorTranscriptEvidence | null {
  if (!frame.final || !frame.itemId || !frame.eventId || !session.browserInstanceId || !session.credentialGeneration) return null
  const persisted = postTalkTranscript(session.sessionId, {
    browserInstanceId: session.browserInstanceId,
    credentialGeneration: session.credentialGeneration,
    providerItemId: frame.itemId,
    providerEventId: frame.eventId,
    transcript: frame.text,
  })
  void persisted.catch(() => {})
  return { itemId: frame.itemId, eventId: frame.eventId, persisted }
}
