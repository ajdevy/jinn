import type { VisualCaptureReceipt } from "../context/visual-capture"
import type { RealtimeFrame } from "./realtime-events"
import { postTalkTurn } from "./session-client"
import type { TalkUsage } from "./usage-delta"

interface SettledTurnRecord {
  sessionId: string
  usage: TalkUsage
  transcript: string
  visualReceipts: readonly VisualCaptureReceipt[]
  frame: Extract<RealtimeFrame, { type: "turn_done" }>
  after?: Promise<void>
}

/** Persist one settled assistant response without coupling the driver to the HTTP envelope. */
export function recordSettledTurn(record: SettledTurnRecord): void {
  void (record.after ?? Promise.resolve()).then(() => postTalkTurn(
    record.sessionId, record.usage, record.transcript, record.visualReceipts, {
      ...(record.frame.responseId ? { providerResponseId: record.frame.responseId } : {}),
      ...(record.frame.itemId ? { providerItemId: record.frame.itemId } : {}),
    })).catch(() => {
    // Accounting must not interrupt a conversation. A failed durable write is
    // visible in telemetry, while throwing here would drop the live exchange.
    })
}
