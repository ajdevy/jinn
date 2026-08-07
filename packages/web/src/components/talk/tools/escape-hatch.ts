import { params, str, type TalkTool, type ToolArgs, type ToolResult } from "./tool-spec"

/**
 * The catch-all, declared and gated off.
 *
 * Everything the orb can do today it does through a named tool. This is the seam
 * for what it cannot: a described intent the write child (ICI-757) turns into an
 * action. It ships declared so that child inherits an argument and result
 * contract rather than designing one against a live voice session, and it
 * refuses out loud rather than succeeding silently — a no-op the model reads as
 * success is worse than no tool at all.
 *
 * ## The contract ICI-757 fills in
 *
 * Arguments
 * - `intent` (required) — what the operator asked for, in their own words.
 * - `subject` — the object it acts on, as an app-visible id ("ABC-59",
 *   a workflow slug, an employee name). Absent means "whatever is on screen".
 * - `detail` — the free text a write needs: a comment body, a new title.
 *
 * Result
 * - Success is `{ ok: true, data: { performed, subject?, undo? } }` where
 *   `performed` is a past-tense sentence the model can say back, and `undo`
 *   names the tool call that reverses it, if one exists.
 * - Refusal is `{ ok: false, error }` — including the refusal below, and every
 *   consent decision ICI-757 adds. A write the operator has not agreed to is a
 *   refusal, not a failure, and reads the same way to the caller either way.
 */

export const ESCAPE_HATCH_TOOL: TalkTool = {
  name: "jinn_action",
  description:
    "Describe an action that no other tool covers. Not available yet: it will report what it would have needed rather than acting.",
  exposure: "on-intent",
  parameters: params(
    {
      intent: str("What the operator asked for, in their own words."),
      subject: str("The id of the thing to act on, if there is one."),
      detail: str("Any text the action needs, such as a comment to leave."),
    },
    ["intent"],
  ),
  execute: (args: ToolArgs): ToolResult => ({
    ok: false,
    error: `"jinn_action" cannot act yet — the orb can navigate and read, but not write. Wanted: ${JSON.stringify(args.intent)}. Tell the operator this needs ICI-757, and use a navigation tool to take them to where they can do it themselves.`,
  }),
}
