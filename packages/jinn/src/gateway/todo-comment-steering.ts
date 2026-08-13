import { logger } from "../shared/logger.js";
import { deliverClaimedSessionDelivery } from "../sessions/callbacks.js";
import {
  claimSessionDeliveryWithinSourceLimit,
  getSession,
  listSessionsByWorkItem,
} from "../sessions/registry.js";
import type { Session, WorkflowSessionProvenance } from "../shared/types.js";
import { addComment, type WorkItemComment } from "../work-items/comments.js";
import { listWorkItemEvents } from "../work-items/store.js";

/**
 * A comment on a Todo reaches whoever is doing the work, while they are still
 * doing it. Without this the board is a letterbox nobody opens until the work is
 * already finished and the steering is worthless.
 *
 * A Todo has one target, never two. If a Workflow run ever ran a phase here the
 * newest phase session owns the conversation and only the operator may steer it,
 * because a run's acceptance criteria are not an employee's to move. Every other
 * Todo routes to the newest live session delegated to it, an ordinary
 * conversation where any author except the target itself may steer.
 *
 * Both branches claim through the delivery outbox, so a comment is forwarded at
 * most once no matter how often this is called — including across a gateway
 * restart, where the composite unique index is the only thing standing between a
 * recovery sweep and a replayed history.
 */

export const MAX_OPERATOR_COMMENTS_PER_WORKFLOW_RUN = 5;

/** The delegation branch's twin of the per-run cap. A Todo thread that has
 *  needed six mid-flight corrections needs a conversation, not a seventh. */
export const MAX_STEERING_COMMENTS_PER_TODO = 5;

function latestWorkflowPhaseSession(todoId: string) {
  const events = listWorkItemEvents(todoId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind !== "session_linked" || typeof event.detail?.sessionId !== "string") continue;
    const session = getSession(event.detail.sessionId);
    if (session?.workflowProvenance?.kind === "phase") return session;
  }
  return undefined;
}

function operatorCommentPrompt(comment: WorkItemComment): string {
  return `💬 The operator commented on Todo ${comment.workItemId} while your workflow run is active or parked.\n\n`
    + `${comment.body}\n\n`
    + `Answer on the Todo by calling comment_work_item { id: "${comment.workItemId}", body: "<answer>", `
    + `parentCommentId: "${comment.id}" }. Do not decide a parked gate or change the run's acceptance criteria from this comment. `
    + `If your phase is still active, continue its original work and call workflow_submit_output when it is complete. `
    + `If the phase already completed, only answer the comment on the Todo.`;
}

/** Forward only the operator side of a Todo conversation to the newest phase
 * session. Employee/system answers stop here, so their Todo comments cannot
 * create a reply loop. */
function forwardToWorkflowPhase(
  comment: WorkItemComment,
  session: Session,
  provenance: WorkflowSessionProvenance,
): void {
  if (comment.authorKind !== "operator" || comment.author !== "operator") return;

  const message = operatorCommentPrompt(comment);
  const claim = claimSessionDeliveryWithinSourceLimit({
    targetSessionId: session.id,
    sourceKind: "workflow-run",
    sourceId: provenance.runId,
    sourceAttempt: comment.id,
    sourceOutcome: "operator-comment",
    sourceVersion: 1,
    deliveryKind: "workflow-todo-comment",
    payload: {
      message,
      displayMessage: `💬 ${comment.workItemId} · operator comment\n${comment.body}`,
    },
  }, MAX_OPERATOR_COMMENTS_PER_WORKFLOW_RUN);
  if (claim.capped) {
    addComment({
      workItemId: comment.workItemId,
      parentCommentId: comment.id,
      author: "workflow",
      authorKind: "system",
      body: `**Comment not forwarded** — workflow run \`${provenance.runId}\` already received `
        + `${MAX_OPERATOR_COMMENTS_PER_WORKFLOW_RUN} operator comments, which is the per-run cap. `
        + `The run and any parked gate are unchanged.`,
    });
    return;
  }
  if (!claim.delivery || claim.delivery.status === "accepted") return;
  deliverClaimedSessionDelivery(claim.delivery.id).catch((error) => {
    logger.warn(`Workflow run ${provenance.runId} could not deliver Todo comment ${comment.id} `
      + `to session ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/**
 * The newest live session working this Todo. `idle` counts alongside `running`
 * because the outbox queues behind a running turn and delivers straight to an
 * idle one: restricting to `running` would drop every comment that lands in the
 * gap between two turns, which is exactly when an operator reads the result and
 * has something to say. An errored session is skipped the way a parent callback
 * skips one.
 */
function latestDelegatedSession(todoId: string) {
  return listSessionsByWorkItem(todoId).find((session) =>
    (session.status === "running" || session.status === "idle")
    && session.workflowProvenance?.kind !== "phase");
}

function steeringPrompt(comment: WorkItemComment): string {
  return `💬 ${comment.author} commented on Todo ${comment.workItemId}, which you are working on.\n\n`
    + `${comment.body}\n\n`
    + `Answer on the Todo by calling comment_work_item { id: "${comment.workItemId}", body: "<answer>", `
    + `parentCommentId: "${comment.id}" }, then carry on with the work you already had in hand.`;
}

/** Steer the newest live delegated session with the Todo's conversation. */
function forwardToDelegatedSession(comment: WorkItemComment): void {
  const session = latestDelegatedSession(comment.workItemId);
  if (!session) return;
  // Never hand a comment back to the identity that wrote it: the prompt asks the
  // session to answer on the Todo, so echoing its own answer to it is the loop.
  // An employee-backed session matches at the EMPLOYEE level, so a sibling
  // session of the same employee is filtered out too — the safe direction, and
  // the same ambiguity the phase branch's operator-only filter already lives with.
  if (comment.authorKind === "system") return;
  if (comment.author === (session.employee ?? `session:${session.id}`)) return;

  const claim = claimSessionDeliveryWithinSourceLimit({
    targetSessionId: session.id,
    sourceKind: "work-item",
    sourceId: comment.workItemId,
    sourceAttempt: comment.id,
    sourceOutcome: "todo-comment",
    sourceVersion: 1,
    deliveryKind: "todo-comment-steering",
    payload: {
      message: steeringPrompt(comment),
      displayMessage: `💬 ${comment.workItemId} · ${comment.author}\n${comment.body}`,
    },
  }, MAX_STEERING_COMMENTS_PER_TODO);
  if (claim.capped) {
    addComment({
      workItemId: comment.workItemId,
      parentCommentId: comment.id,
      author: "jinn",
      authorKind: "system",
      body: `**Comment not forwarded** — this Todo has already steered `
        + `${MAX_STEERING_COMMENTS_PER_TODO} comments into its session, which is the cap. `
        + `The session is unchanged and did not see this comment; reply in the session itself if it cannot wait.`,
    });
    return;
  }
  if (!claim.delivery || claim.delivery.status === "accepted") return;
  deliverClaimedSessionDelivery(claim.delivery.id).catch((error) => {
    logger.warn(`Todo ${comment.workItemId} could not deliver comment ${comment.id} `
      + `to session ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export function forwardWorkflowTodoComment(comment: WorkItemComment): void {
  const phase = latestWorkflowPhaseSession(comment.workItemId);
  const provenance = phase?.workflowProvenance;
  if (phase && provenance?.kind === "phase") return forwardToWorkflowPhase(comment, phase, provenance);
  forwardToDelegatedSession(comment);
}
