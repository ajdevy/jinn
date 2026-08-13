import { closeWorkItemRun, findOpenWorkItemRunBySession, openWorkItemRun } from "../work-items/runs.js";
import { linkSession } from "../work-items/store.js";
import { getTodoDispatchConfig } from "../work-items/dispatch-config.js";
import type { WorkflowTodoDispatchOverride, WorkflowTodoSessionLink } from "../workflows/todo-ports.js";

/**
 * The session half of what a Todo-bound Workflow run owes its Todo: each phase
 * session is linked to the Todo so the run's derived spend covers the whole
 * pipeline, and each phase ATTEMPT opens and settles a row in that Todo's run
 * ledger.
 *
 * The two are deliberately one port. A phase session and a phase attempt are
 * the same event seen from two sides, and splitting them invites a gateway that
 * wires one and forgets the other. Failures propagate: the runner already
 * treats every call here as best-effort, so swallowing anything a second time
 * would only hide it.
 */
export function workflowTodoSessions(): WorkflowTodoSessionLink {
  return {
    link: ({ todoId, sessionId }) => linkSession(todoId, sessionId),

    openRun: ({ todoId, sessionId, startedAt }) => {
      openWorkItemRun({ workItemId: todoId, sessionId, startedAt });
    },

    closeRun: ({ sessionId, outcome, endedAt, summary, handoff, error }) => {
      const open = findOpenWorkItemRunBySession(sessionId);
      // No open run means the attempt never dispatched, or the terminal path
      // that got here first already settled it. Nothing to close, nothing to
      // report — the ledger's one-close rule lives in `closeWorkItemRun`.
      if (!open) return;
      closeWorkItemRun(open.id, {
        outcome,
        endedAt,
        ...(summary ? { summary } : {}),
        ...(handoff ? { handoff } : {}),
        ...(error ? { error } : {}),
      });
    },
  };
}

/**
 * The other direction (ICI-733): what the Todo tells the run. Read fresh per
 * attempt, so an override set while an attempt was in flight lands on the next
 * one and never disturbs the one already running.
 */
export function workflowTodoDispatch(): WorkflowTodoDispatchOverride {
  return { read: (todoId) => getTodoDispatchConfig(todoId) };
}
