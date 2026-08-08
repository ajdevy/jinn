import { recordTalkAction } from "../talk-action-log"
import { askSituation } from "../talk-situation-store"
import type { ToolResult } from "./tool-spec"

/**
 * The one gate every situation-first write goes through.
 *
 * Voice is a lossy consent channel: a transcription error and a spoken sentence
 * look identical by the time a tool call arrives. So anything outward-facing,
 * billed, or unreversible raises a sheet and waits, and the write is not even
 * reachable until an answer comes back — `perform` is a callback rather than a
 * flag precisely so "did not ask" cannot be a code path.
 *
 * A dismissal is a REFUSAL, not a failure. It reports as `{ ok: false }` like
 * every other unhappy outcome, because a model that reads "the operator said no"
 * as a transport error will retry it.
 */

const GO = "go"

/** Distinct per ask: two consecutive consents for the same tool and subject are
 *  two different decisions, and the sheet keys its entrance on the situation. */
let asked = 0

export interface ConsentRequest {
  tool: string
  /** What is about to happen, in the operator's terms. */
  title: string
  /** One supporting line under the title. */
  hint?: string
  /** The affirmative card's label — a verb, not "OK". */
  confirm: string
  /** What the write acts on, as an app-visible id. */
  subject: string | null
}

export async function withConsent(
  request: ConsentRequest,
  perform: () => Promise<ToolResult>,
): Promise<ToolResult> {
  asked += 1
  const choice = await askSituation({
    id: `consent-${asked}`,
    title: request.title,
    ...(request.hint ? { hint: request.hint } : {}),
    payload: {
      kind: "options",
      options: [
        { id: GO, label: request.confirm },
        { id: "leave", label: "Leave it" },
      ],
    },
  })
  const granted = choice === GO
  recordTalkAction({
    tool: request.tool,
    subject: request.subject,
    lane: "consent",
    consent: granted ? "granted" : "refused",
  })
  if (!granted) {
    return {
      ok: false,
      error: `Refused: the operator did not agree to "${request.tool}"${request.subject ? ` on ${request.subject}` : ""}. Nothing was written. Say what you understood and let them correct it.`,
    }
  }
  return perform()
}
