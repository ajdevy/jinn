import { addComment } from "../work-items/comments.js";
import { addWorkItemLabels } from "../work-items/labels.js";
import { listApprovals } from "../work-items/approval-rows.js";
import { WORKFLOW_RUN_ACTOR, type WorkItemStatus } from "../work-items/store.js";
import { transition, transitionDerived, TransitionError } from "../work-items/transitions.js";
import { parseTodoApprovalRef } from "../workflows/todo-approval-ref.js";
import type { WorkflowRevisionRequest } from "../workflows/runner.js";
import { gateTrail, quoted } from "./workflow-todo-gate.js";

/**
 * The feedback half of the Todo surface: what happens to a bound Todo when a
 * run-bound Approval gate is rejected WITH a note.
 *
 * It lives beside `workflow-todo-surface.ts` rather than inside it because it is
 * a loop with its own rules — a cycle bound, and a re-arm that has to satisfy the
 * trigger it is arming — while the surface next door is a set of one-shot
 * reflections. The surface re-exports what it hands the runner.
 */

/**
 * Re-arms allowed on one Todo before the loop ends in front of the operator
 * instead. Each cycle needs a FRESH human rejection, so it cannot spin on its
 * own; the bound is here because a Todo that has been round three times is a
 * signal about the brief rather than a workflow, and a fourth full pipeline run
 * buys less than a conversation. Three is also the platform's existing top
 * rework ceiling (`thorough`), so no new number was invented.
 *
 * Deliberately NOT the Todo's `rounds` / `verifyPolicy.maxRounds` budget. That
 * one bounds an UNGATED machine loop (verifier ↔ executor), which is why it stops
 * at two: sharing it would let a run's own rework spend the operator's revision
 * allowance, and the board renders it as "Review round N of M", which a workflow
 * revision is not.
 */
export const MAX_REVISION_CYCLES = 3;

/**
 * How many times a run-bound gate on this Todo has been rejected WITH feedback,
 * counting the rejection being handled right now (the Todo-side decision commits
 * before the run is told). Derived from the approval history rather than kept in
 * a counter of its own: every cycle already leaves a durable rejected row with
 * its note, so a derived count cannot drift from the trail that justifies it.
 */
function revisionCycles(todoId: string): number {
  return listApprovals(todoId).filter((approval) => approval.state === "rejected"
    && (approval.note ?? "").trim().length > 0
    && parseTodoApprovalRef(approval.ref) !== null).length;
}

/**
 * A revision that will not happen. Says WHY on the Todo and parks it, because a
 * Todo left sitting at a status whose trigger fires nothing looks queued forever
 * — the single worst outcome here. `escalated` when the loop is spent (that is a
 * decision waiting on the operator), `blocked` when the pipeline simply cannot
 * run again.
 */
function stopRevision(input: WorkflowRevisionRequest, why: string, status: "blocked" | "escalated"): void {
  addComment({
    workItemId: input.todoId,
    author: "workflow",
    authorKind: "system",
    body: `**Rejected with feedback, but not sent back** — ${why}.\n\n${quoted(input.feedback)}\n\n`
      + `${gateTrail(input)}. Nothing will re-run until someone moves this Todo.`,
  });
  transitionDerived(input.todoId, status, WORKFLOW_RUN_ACTOR, {
    declared: true,
    revisionStopped: why,
    workflowId: input.workflowId,
    runId: input.runId,
    nodeId: input.nodeId,
  }, "transient");
}

/**
 * The feedback loop, and the whole reason this hook exists: a rejection carrying
 * a note means "do it again with this", so the note lands as a comment (where the
 * next run's first phase reads it) and the Todo returns to the status its own
 * workflow trigger fires on. The rejecter is the actor, because they decided it.
 */
export function requestRevision(input: WorkflowRevisionRequest): void {
  const cycles = revisionCycles(input.todoId);
  if ("unavailable" in input.rearm) {
    return stopRevision(input, `it cannot run again: ${input.rearm.unavailable}`, "blocked");
  }
  if (cycles > MAX_REVISION_CYCLES) {
    return stopRevision(input, `it has already been sent back ${cycles - 1} times`
      + ` (the cap is ${MAX_REVISION_CYCLES}) — this needs a conversation, not another run`, "escalated");
  }
  // Two trigger filters a re-arm can break by itself. The ACTOR is whoever
  // rejected the gate, and nothing can change that, so a mismatch is fatal. The
  // LABEL can be put back — a phase that disarmed the Todo mid-run took it off —
  // and it has to go back BEFORE the move, because the move is what kicks the
  // drain that reads it. Every other filter reads something the run left alone.
  if (input.rearm.actor !== undefined && input.rearm.actor !== input.decidedBy) {
    return stopRevision(input, `its trigger only fires for actor \`${input.rearm.actor}\``
      + ` and \`${input.decidedBy}\` rejected this, so a re-arm would fire nothing`, "blocked");
  }
  if (input.rearm.label !== undefined) {
    try {
      addWorkItemLabels(input.todoId, [input.rearm.label], input.decidedBy);
    } catch (error) {
      return stopRevision(input, `its trigger only fires for Todos labelled \`${input.rearm.label}\``
        + `, which could not be put back: ${error instanceof Error ? error.message : String(error)}`, "blocked");
    }
  }
  addComment({
    workItemId: input.todoId,
    author: "workflow",
    authorKind: "system",
    body: `**Sent back for revision** (round ${cycles} of ${MAX_REVISION_CYCLES}) — `
      + `${gateTrail(input)}.\n\nThis is the current requirement. It was written after seeing the last `
      + `result, so where it conflicts with the original description, this wins.\n\n${quoted(input.feedback)}`,
  });
  try {
    transition(input.todoId, input.rearm.status as WorkItemStatus, input.decidedBy, {
      requeue: true,
      detail: { revision: cycles, feedback: input.feedback, workflowId: input.workflowId,
        runId: input.runId, nodeId: input.nodeId },
    });
  } catch (error) {
    if (!(error instanceof TransitionError)) throw error;
    stopRevision(input, `it could not be moved to \`${input.rearm.status}\`: ${error.message}`, "blocked");
  }
}
