import { queryClient } from "@/lib/query-client"
import { recordTalkAction } from "../talk-action-log"
import { offerUndo } from "../talk-undo-store"
import type { ToolResult } from "./tool-spec"

/**
 * The fast lane: speak, and it happens.
 *
 * What makes it safe is not that these writes are small — it is that each one
 * arrives with a reversal already on the table. That is why every fast-lane
 * success is built here rather than by each tool: a tool cannot return `ok`
 * without handing over the `reverse` that {@link offerUndo} will run, so "fast
 * with no way back" is not a shape this lane can express.
 */

/** The tool the model calls to reverse the last fast-lane write, and the name
 *  every fast-lane result hands back as its `undo`. */
export const UNDO_TOOL = "talk_undo"

export interface FastWrite {
  tool: string
  /** What it acted on, as an app-visible id. */
  subject: string | null
  /** Past tense, said back by the model and shown on the strip. */
  performed: string
  /** Anything else the model should know, merged into the result's data. */
  data?: Record<string, unknown>
  /** Puts it back. Throwing leaves the write standing and reports why. */
  reverse: () => Promise<void>
}

/**
 * The orb's read tools answer from a PRESENT cache entry even once it is stale,
 * so a talk write has to remove the detail rather than merely invalidate it —
 * otherwise the orb reads back the world as it was before it spoke. The app's
 * own list surfaces refetch on the invalidation as usual.
 */
function forgetCached(subject: string | null): void {
  if (subject) queryClient.removeQueries({ queryKey: ["work-item", subject], exact: true })
  void queryClient.invalidateQueries({ queryKey: ["work-items"] })
}

export function fastWrite(write: FastWrite): ToolResult {
  forgetCached(write.subject)
  const entry = recordTalkAction({
    tool: write.tool,
    subject: write.subject,
    lane: "fast",
    consent: "not-required",
  })
  offerUndo(write.performed, async () => {
    try {
      await write.reverse()
      forgetCached(write.subject)
    } finally {
      // Logged whether or not the reversal landed, because the log records what
      // was ATTEMPTED — and a reversal the gateway refused is the attempt most
      // worth being able to find afterwards. `entry.id` is filled in when the
      // gateway acknowledges the entry above, so an unacknowledged one links to
      // nothing rather than to a guess.
      recordTalkAction({
        tool: UNDO_TOOL,
        subject: write.subject,
        lane: "fast",
        consent: "not-required",
        ...(entry.id ? { undoOf: entry.id } : {}),
      })
    }
  })
  return {
    ok: true,
    data: {
      performed: write.performed,
      ...(write.subject ? { subject: write.subject } : {}),
      undo: UNDO_TOOL,
      ...write.data,
    },
  }
}

/** One shape for every write that could not reach the gateway, so a refusal and
 *  a network failure never read the same way to the model. Consent-lane callers
 *  use this directly: their attempt was logged by the sheet before it ran. */
export function writeFailed(what: string, error: unknown): ToolResult {
  const why = error instanceof Error && error.message ? error.message : "the gateway did not answer"
  return { ok: false, error: `Could not ${what}: ${why}.` }
}

/** A fast-lane write the gateway refused. It logs, because the fast lane has no
 *  sheet to have logged it already and a write that was tried and failed is
 *  still a write that was tried. */
export function fastWriteFailed(
  attempt: { tool: string; subject: string | null },
  what: string,
  error: unknown,
): ToolResult {
  recordTalkAction({ tool: attempt.tool, subject: attempt.subject, lane: "fast", consent: "not-required" })
  return writeFailed(what, error)
}
