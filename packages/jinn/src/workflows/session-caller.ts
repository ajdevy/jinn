import type { WorkflowRepository } from "./repository.js";
import { callerIdentity, fail } from "./service-input.js";
import type { WorkflowCallInput } from "./service.js";

/**
 * Which Workflow invocation a new run is being started on behalf of, and whether
 * that invocation may reach the target at all. A Workflow Call names its caller
 * outright; a run started from an attempt session has to be traced back to one.
 */

type CallerRepository = Pick<WorkflowRepository, "getRun" | "findAttemptBySessionId" | "listRecoverableRuns">;
type WorkflowCaller = WorkflowCallInput["caller"];

/** The invocation a session speaks for, or null when the session is not one —
 *  an operator, a cron run, or an attempt that has already settled. */
export function callerForSession(repository: CallerRepository, sessionId: string | undefined): WorkflowCaller | null {
  if (sessionId === undefined) return null;
  const attempt = repository.findAttemptBySessionId(sessionId);
  if (!attempt || !["dispatching", "running"].includes(attempt.status)) return null;
  const run = repository.listRecoverableRuns().find((candidate) => candidate.id === attempt.runId);
  return run ? { workflowId: run.workflowId, runId: run.id, nodeId: attempt.nodeId } : null;
}

/** Refuse a caller that is not a live invocation, or whose ancestry re-enters the
 *  target, loops, unwinds into a run already being cancelled, or nests deeper than
 *  a Workflow tree has any reason to go. */
export function assertCallableCaller(repository: CallerRepository, targetWorkflowId: string, caller: WorkflowCaller): void {
  let current = repository.getRun(caller.workflowId, caller.runId)
    ?? fail("bad-input", "Workflow caller run was not found.");
  const authored = current.definition.nodes.find((node) => node.id === caller.nodeId);
  const runtime = current.nodeRuns.find((node) => node.nodeId === caller.nodeId);
  const attempt = current.attempts.filter((item) => item.nodeId === caller.nodeId).at(-1);
  const activeEmployee = authored?.type === "employee" && attempt && ["dispatching", "running"].includes(attempt.status);
  const activeWorkflowCall = authored?.type === "workflow-call" && runtime?.status === "running";
  if (!runtime?.activated || (!activeEmployee && !activeWorkflowCall)) {
    fail("bad-input", "Workflow caller node is not an active invocation.");
  }
  const seen = new Set<string>();
  for (let depth = 0; depth < 128; depth += 1) {
    if (current.cancelRequestedAt) fail("bad-input", "Workflow caller run is being cancelled.");
    if (current.workflowId === targetWorkflowId) fail("bad-input", "Workflow call recursion is not allowed.");
    if (seen.has(current.id)) fail("bad-input", "Workflow caller ancestry contains a cycle.");
    seen.add(current.id);
    // A Workflow Call always names its caller; any other trigger names one only
    // when a running attempt started the run, and otherwise ends the ancestry.
    if (current.trigger.kind !== "workflow-call" && current.trigger.payload.caller === undefined) return;
    const parent = current.trigger.payload.caller;
    if (!callerIdentity(parent)) fail("bad-input", "Workflow caller ancestry is invalid.");
    current = repository.getRun(parent.workflowId, parent.runId)
      ?? fail("bad-input", "Workflow caller ancestry was not found.");
    if (!current.definition.nodes.some((node) => node.id === parent.nodeId
      && (node.type === "employee" || node.type === "workflow-call"))) {
      fail("bad-input", "Workflow caller ancestry is invalid.");
    }
  }
  fail("bad-input", "Workflow caller ancestry is too deep.");
}
