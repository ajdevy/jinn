/**
 * What one live Talk conversation is, as data.
 *
 * Split out of `session-driver.ts` so the tool lane can be its own module
 * without either file importing the other back.
 */
import type { OrbState } from "../orb-motion"
import type { createVisualCapture, VisualCaptureReceipt } from "../context/visual-capture"
import type { OperatorTranscriptEvidence } from "./operator-transcript-evidence"
import type { TalkControlManifest } from "./control-manifest"
import type { TalkUiEffect } from "./ui-effects"
import type { TalkUsage } from "./usage-delta"
import type { DriverProactiveCues } from "./driver-proactive-cues"
import type { FalseStartRecovery, InterruptionTelemetry } from "./false-start-recovery"

export interface TalkDriverOptions {
  sessionId: string
  browserInstanceId?: string
  credentialGeneration?: number
  /** What this instance is, as the gateway described it when the session opened
   *  — the company, its conventions, and who works here. Absent on a session
   *  opened against a gateway that does not send one. */
  brief?: string
  topicMemory?: string
  manifest: TalkControlManifest
  /** Send one client event over the `oai-events` data channel. */
  send: (event: Record<string, unknown>) => void
  onState: (state: OrbState) => void
  onError: (message: string) => void
  vadType?: InterruptionTelemetry["vadType"]
  onInterruption?: (event: InterruptionTelemetry) => void
  visualCapture?: ReturnType<typeof createVisualCapture>
  applyUiEffect?: (effect: TalkUiEffect | null) => Promise<void>
}

/** Everything one live conversation remembers: what has been billed, what the
 *  assistant last said, what the orb is currently showing, and enough about the
 *  tool calls in flight to answer one utterance exactly once. */
export interface DriverState {
  options: TalkDriverOptions
  billed: TalkUsage
  said: string
  state: OrbState
  /** Every `call_id` already dispatched. A provider that replays one must not
   *  make the browser write twice. It lives as long as the connection, which is
   *  the right scope: a park and resume builds a new driver, and no `call_id`
   *  outlives the response that issued it. */
  executed: Set<string>
  /** Tool calls still running. One response can carry several, and it is the
   *  last of them to answer that asks for the reply — not each of them. */
  outstanding: number
  /** True between `response.created` and `response.done`. The conversation
   *  holds one response at a time; asking during it is refused. */
  responding: boolean
  /** A tool answered while a response was in flight, so a request is still
   *  owed once that response ends. */
  owed: boolean
  /** The operator started speaking over the current response. Its tool effects
   *  may still settle (and are still answered once), but none of those late
   *  results may start another spoken response. A provider-created response
   *  for the new utterance clears this fence. */
  interrupted: boolean
  activeResponseId: string | null
  playbackResponseId: string | null
  completedResponseId: string | null
  handledUserItems: Set<string>
  recovery: FalseStartRecovery
  proactive: DriverProactiveCues
  stopped: boolean
  lastUserRequestKey: string | null
  lastUserEvidence: OperatorTranscriptEvidence | null
  visualReceipts: VisualCaptureReceipt[]
  visualCapture: ReturnType<typeof createVisualCapture>
}
