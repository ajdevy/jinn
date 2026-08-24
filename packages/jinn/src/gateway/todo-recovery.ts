import { logger } from "../shared/logger.js";
import { loadConfig } from "../shared/config.js";
import { sweepTodoRecovery, todoRecoveryMode } from "../work-items/recovery-controller.js";
import { detectTodoAnomalies } from "../work-items/anomaly-detect.js";
import { currentApproval } from "../work-items/approvals.js";
import { getWorkItem } from "../work-items/store.js";
import { reachedSuccessEnd } from "../workflows/run-closure.js";
import { parseTodoApprovalRef } from "../workflows/todo-approval-ref.js";
import { availabilityRearm } from "./availability-resume.js";
import { workflowTodoLifecycle } from "./workflow-todo-surface.js";
import type { WorkflowRepository } from "../workflows/repository.js";

const DEFAULT_INTERVAL_MS = 5 * 60_000;

function approvedDecision(todoId: string) {
  const approval = currentApproval(todoId);
  if (approval?.state !== "approved") return null;
  if (!approval.decidedBy || !approval.decidedAt) return null;
  return { ...approval, decidedBy: approval.decidedBy, decidedAt: approval.decidedAt };
}

function completedExactRun(todoId: string, run: ReturnType<WorkflowRepository["getRun"]>): boolean {
  if (!run || run.trigger.todoId !== todoId) return false;
  return run.status === "completed" && Boolean(run.endedAt) && reachedSuccessEnd(run);
}

function exactGateApproved(run: NonNullable<ReturnType<WorkflowRepository["getRun"]>>, nodeId: string): boolean {
  const authored = run.definition.nodes.find((node) => node.id === nodeId);
  if (authored?.type !== "approval") return false;
  const runtime = run.nodeRuns.find((node) => node.nodeId === nodeId);
  if (runtime?.status !== "completed") return false;
  const gate = run.approvals.find((candidate) => candidate.nodeId === nodeId);
  return gate?.status === "approved" && Boolean(gate.decidedBy && gate.decidedAt);
}

function referencedRun(repository: WorkflowRepository, workflowId: string, runId: string) {
  try {
    return repository.getRun(workflowId, runId);
  } catch {
    return null;
  }
}

/**
 * Classify (and, if enabled, apply) bounded Todo recovery. Default mode is
 * classify-only so production observes lanes without auto-rearming until the
 * reviewed gate flips `gateway.todoRecovery.mode` to `auto`.
 */
export function approvedLandingComplete(todoId: string, repository: WorkflowRepository): boolean {
  const approval = approvedDecision(todoId);
  if (!approval) return false;
  const origin = parseTodoApprovalRef(approval.ref);
  if (!origin) return false;
  const run = referencedRun(repository, origin.workflowId, origin.runId);
  if (!run || !completedExactRun(todoId, run)) return false;
  return exactGateApproved(run, origin.nodeId);
}

export function closeApprovedLanded(todoId: string, repository: WorkflowRepository): boolean {
  if (!approvedLandingComplete(todoId, repository)) return false;
  const approval = approvedDecision(todoId)!;
  const origin = parseTodoApprovalRef(approval.ref)!;
  workflowTodoLifecycle.complete({
    todoId, workflowId: origin.workflowId, runId: origin.runId, nodeId: origin.nodeId,
    approvedBy: approval.decidedBy, approvedAt: approval.decidedAt,
  });
  return getWorkItem(todoId)?.status === "done";
}

export function startTodoRecovery(repository: WorkflowRepository, intervalMs = DEFAULT_INTERVAL_MS): () => void {
  const tick = (): void => {
    try {
      const mode = todoRecoveryMode(loadConfig().gateway.todoRecovery?.mode);
      if (mode === "off") return;
      const result = sweepTodoRecovery({
        mode,
        rearm: (todoId) => availabilityRearm(todoId, repository),
      });
      const anomalies = detectTodoAnomalies({
        persist: true,
        approvedLandingComplete: (todoId) => approvedLandingComplete(todoId, repository),
        closeApprovedLanded: (todoId) => closeApprovedLanded(todoId, repository),
      });
      if (result.classified > 0 || result.applied > 0 || anomalies.length > 0) {
        logger.info(
          `Todo recovery: classified ${result.classified}, applied ${result.applied}, anomalies ${anomalies.length} (mode ${mode})`,
        );
      }
    } catch (err) {
      logger.warn(`Todo recovery sweep failed: ${err instanceof Error ? err.message : err}`);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
