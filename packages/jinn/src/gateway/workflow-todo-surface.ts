import { logger } from "../shared/logger.js";
import { deliverClaimedSessionDelivery } from "../sessions/callbacks.js";
import { claimSessionDelivery, listSessionsForGroup } from "../sessions/registry.js";
import { currentApproval } from "../work-items/approval-rows.js";
import { addComment } from "../work-items/comments.js";
import {
  getWorkItem,
  isBlockDeclared,
  WORKFLOW_RUN_ACTOR,
  type ApprovalTargetKind,
  type WorkItemStatus,
} from "../work-items/store.js";
import { transition, transitionDerived, TransitionError } from "../work-items/transitions.js";
import { gateTrail, recordApprovalDecision } from "./workflow-todo-gate.js";
import { requestRevision } from "./workflow-todo-revision.js";
import type { WorkflowError } from "../workflows/runtime.js";
import type {
  WorkflowRunReflection,
  WorkflowTodoApprovalMirror,
  WorkflowTodoLifecycle,
} from "../workflows/runner.js";

/**
 * What a Todo-bound Workflow run owes the Todo it runs for, implemented once in
 * the platform instead of once per workflow author.
 *
 * Before this, the only reason a bound Todo moved during a run was an author
 * hand-writing `update_work_item` into every phase prompt and wiring a
 * record-failure branch into the graph. One forgotten instruction left a merged
 * Todo reading `assigned`, and a parked gate told nobody at all.
 *
 * Six obligations:
 *   - reflect the run's lifecycle onto the Todo's status
 *   - record each gate decision on the Todo
 *   - record WHY a run settled failed
 *   - wake the routed employee when the run parks on their decision
 *   - send the work round again when that approver rejects WITH feedback
 *   - close a successful run after an operator-only gate supplied the review
 *
 * Completion remains absent for every other path. Reaching a success End alone
 * is not a review; only a recorded operator-only approval supplies the human
 * authority to close without weakening the self-review rule.
 */

/**
 * Whether a reflection is allowed to move this Todo. Sticky terminals need no
 * check — `transition` refuses to leave them without human authority — so this
 * is only about the statuses a phase can deliberately choose.
 *
 *   - `executing` is the START edge, legal only out of `backlog`/`assigned` (the
 *     same rule `transition` applies to a manual start). Anywhere else, a phase
 *     has already said something more specific and keeps it.
 *   - `in_review` yields to a DECLARED block: a phase that blocked with a real
 *     reason says more than "a decision is pending".
 *   - `blocked` always writes. A run that died is the newest and most
 *     consequential fact about the work, and leaving the board on a phase's
 *     optimistic `in_review` is the exact lie this surface exists to stop.
 */
function mayReflect(status: WorkflowRunReflection, current: WorkItemStatus, todoId: string): boolean {
  if (status === "executing") return current === "backlog" || current === "assigned";
  if (status === "in_review") return !(current === "blocked" && isBlockDeclared(todoId));
  return true;
}

function reflect(input: {
  todoId: string; status: WorkflowRunReflection; workflowId: string; runId: string; nodeId: string;
}): void {
  const item = getWorkItem(input.todoId);
  if (!item || !mayReflect(input.status, item.status, input.todoId)) return;
  // `declared: false` keeps this out of the declaration lane: the reconciler's
  // provenance checks read it, so a reflected status stays re-derivable instead of
  // freezing the Todo. A dead run blocks `transient`: one recurring problem, not two.
  transitionDerived(input.todoId, input.status, WORKFLOW_RUN_ACTOR, {
    declared: false,
    workflowId: input.workflowId,
    runId: input.runId,
    nodeId: input.nodeId,
  }, "transient");
}

function recordFailure(input: {
  todoId: string; workflowId: string; runId: string; nodeId: string; error: WorkflowError;
}): void {
  addComment({
    workItemId: input.todoId,
    author: "workflow",
    authorKind: "system",
    body: `**Workflow run failed** — \`${input.workflowId}\` run \`${input.runId}\`.\n\n`
      + `Node \`${input.nodeId}\` (${input.error.code}): ${input.error.message}`,
  });
}

function complete(input: Parameters<WorkflowTodoLifecycle["complete"]>[0]): void {
  const item = getWorkItem(input.todoId);
  if (!item) return;
  if (item.status !== "in_review") {
    logger.debug(`Workflow run ${input.runId} left Todo ${input.todoId} at ${item.status}; only in_review can close.`);
    return;
  }
  try {
    transition(input.todoId, "done", input.approvedBy, {
      detail: {
        workflowId: input.workflowId,
        runId: input.runId,
        nodeId: input.nodeId,
        approvedBy: input.approvedBy,
        approvedAt: input.approvedAt,
      },
    });
  } catch (error) {
    if (!(error instanceof TransitionError)) throw error;
    addComment({
      workItemId: input.todoId,
      author: "workflow",
      authorKind: "system",
      body: `**Workflow completed, but this Todo stayed open** — ${error.message}.\n\n${gateTrail(input)}.`,
    });
  }
}

/** The gate text, trimmed to a length that reads in a notification banner. */
function gateRequest(request: string): string {
  const oneLine = request.replace(/\s+/g, " ").trim();
  return oneLine.length <= 300 ? oneLine : `${oneLine.slice(0, 300)}…`;
}

/**
 * Which session should be woken about a gate. The Todo's approval row already
 * carries the ROUTED approver, resolved when the gate was mirrored, so this only
 * has to turn that into a session:
 *
 * Employee-routed gates wake that employee's most recent live session. Gates
 * routed to the virtual root, and gates reserved for the operator, stay on the
 * Todo board without waking a chat.
 *
 * An errored session is skipped the same way a parent callback skips one.
 */
function approverSession(
  target: string | null,
  kind: ApprovalTargetKind | null | undefined,
  operatorOnly: boolean,
) {
  if (operatorOnly || kind !== "employee" || !target) return undefined;
  return listSessionsForGroup(target, 5, 0)
    .find((candidate) => candidate.status !== "error");
}

/**
 * A parked gate is already mirrored onto the Todo, where it remains visible and
 * decidable. Employee-routed gates also wake that employee's live session.
 * `claimSessionDelivery` is keyed on the gate's correlation ref, so a re-mirror
 * on a later recovery sweep is a no-op rather than a second ping.
 */
function notifyParked(input: {
  todoId: string; workflowId: string; runId: string; nodeId: string; request: string; ref: string;
}): void {
  const approval = currentApproval(input.todoId);
  const session = approverSession(
    approval?.target ?? null,
    approval?.targetKind,
    approval?.operatorOnly ?? false,
  );
  if (!session) return;

  const decision = gateRequest(input.request);
  const message =
    `⏸️ Workflow \`${input.workflowId}\` is parked waiting on YOUR decision.\n\n`
    + `Todo: ${input.todoId}\n`
    + `Run: ${input.runId} · node \`${input.nodeId}\`\n`
    + `Decision wanted: ${decision}\n\n`
    + `Decide it with decide_work_item_approval { id: "${input.todoId}", decision: "approve" | "reject" }`
    + `${approval?.options?.length ? `, choice: one of ${approval.options.map((option) => `"${option}"`).join(", ")}` : ""}. `
    + `The run stays parked until you do.`;
  const { delivery } = claimSessionDelivery({
    targetSessionId: session.id,
    sourceKind: "workflow-run",
    sourceId: input.runId,
    sourceAttempt: input.ref,
    sourceOutcome: "parked",
    sourceVersion: 1,
    deliveryKind: "workflow-approval-parked",
    payload: {
      message,
      displayMessage: `⏸️ ${input.todoId} needs a decision\n${decision}`,
    },
  });
  if (delivery.status === "accepted") return;
  deliverClaimedSessionDelivery(delivery.id).catch((error) => {
    logger.warn(`Workflow run ${input.runId} could not deliver its parked-gate notice to session ${session.id}: `
      + `${error instanceof Error ? error.message : String(error)}`);
  });
}

/** The Todo-comment bridge and the revision loop live next door; re-exported so
 *  the call sites in the API keep a single import path for the whole surface. */
export { forwardWorkflowTodoComment } from "./todo-comment-steering.js";
export { MAX_REVISION_CYCLES } from "./workflow-todo-revision.js";

/** The lifecycle half of the surface (status, decisions, completion, failure record, revision loop). */
export const workflowTodoLifecycle: WorkflowTodoLifecycle = {
  reflect,
  recordApprovalDecision,
  complete,
  recordFailure,
  requestRevision,
};

/** The approval half: `request` mirrors the gate, `notifyParked` wakes a routed employee. */
export function workflowTodoApprovals(
  request: WorkflowTodoApprovalMirror["request"],
): WorkflowTodoApprovalMirror {
  return { request, notifyParked };
}
