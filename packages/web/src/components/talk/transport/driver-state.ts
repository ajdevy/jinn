/**
 * What one live conversation remembers.
 *
 * Split out of `session-driver.ts` so the loop that handles frames reads as a
 * loop: this is the shape it mutates, and every field here exists because the
 * provider can replay, interleave, or cancel something.
 */
import type { OrbState } from "../orb-motion"
import type { OperatorTranscriptEvidence } from "./operator-transcript-evidence"
import type { TalkDriverOptions } from "./session-driver"
import type { TalkUsage } from "./usage-delta"
import type { VisualCaptureReceipt, createVisualCapture } from "../context/visual-capture"
import type { FalseStartRecovery } from "./false-start-recovery"
import type { DriverProactiveCues } from "./driver-proactive-cues"

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
