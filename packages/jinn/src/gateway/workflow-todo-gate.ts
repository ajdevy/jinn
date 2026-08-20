import { currentApproval } from "../work-items/approval-rows.js";
import { decideApproval } from "../work-items/approval-decision-row.js";
import { addComment } from "../work-items/comments.js";
import { parseTodoApprovalRef } from "../workflows/todo-approval-ref.js";
import type { WorkflowTodoLifecycle } from "../workflows/runner.js";

/**
 * What a decided gate owes the Todo it was mirrored onto: the note that says
 * what was decided, and the settling of the mirrored approval row itself.
 *
 * The row matters because a gate has two doors. Decided on the Todo, the row
 * settles first and the run is told afterwards. Decided on the run — from the
 * inspector, from MCP, from an operator-only gate the Todo surface will not
 * offer — nothing used to settle it, so the Todo kept showing a decision that
 * had already been made, and the reconciler withheld its trust auto-close on a
 * gate nobody was still waiting for.
 *
 * Both doors now end here, and the settle is idempotent by construction: it
 * writes only a PENDING row whose ref names this very gate. That is also why it
 * uses the raw row write rather than the notifying one — the notifying door
 * wakes the mirror-back listener, which would re-enter the run decision this
 * settle was triggered by.
 */

/** `workflow-x` run `run_y` · gate `node_z` — the same trail on every gate note. */
export function gateTrail(input: { workflowId: string; runId: string; nodeId: string }): string {
  return `\`${input.workflowId}\` run \`${input.runId}\` · gate \`${input.nodeId}\``;
}

/** The rejecter's own words, quoted so the next run's first phase reads feedback
 *  and not a paraphrase of it. */
export function quoted(feedback: string): string {
  return feedback.split("\n").map((line) => `> ${line}`).join("\n");
}

type GateDecision = Parameters<WorkflowTodoLifecycle["recordApprovalDecision"]>[0];

/** Settle the Todo's mirror of THIS gate, if it is still waiting for one. A row
 *  that is already decided, absent, native, or another gate's is left alone. */
function settleMirror(input: GateDecision): void {
  const pending = currentApproval(input.todoId);
  if (pending?.state !== "pending") return;
  const origin = parseTodoApprovalRef(pending.ref);
  if (origin?.runId !== input.runId || origin.nodeId !== input.nodeId) return;
  decideApproval(input.todoId, input.decision, input.decidedBy, input.note?.trim() || undefined, input.choice);
}

export function recordApprovalDecision(input: GateDecision): void {
  settleMirror(input);
  const decision = input.decision === "approve" ? "approved" : "rejected";
  const context = [
    input.choice !== undefined ? `Picked option: \`${input.choice}\`.` : undefined,
    input.note?.trim() ? `Note:\n\n${quoted(input.note.trim())}` : undefined,
    `${gateTrail(input)}.`,
  ].filter((part): part is string => part !== undefined).join("\n\n");
  addComment({
    workItemId: input.todoId,
    author: "workflow",
    authorKind: "system",
    body: `**Workflow gate ${decision}** by \`${input.decidedBy}\`.\n\n${context}`,
  });
}
