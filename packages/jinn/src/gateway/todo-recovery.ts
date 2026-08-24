import { logger } from "../shared/logger.js";
import { loadConfig } from "../shared/config.js";
import { sweepTodoRecovery, todoRecoveryMode } from "../work-items/recovery-controller.js";
import { detectTodoAnomalies } from "../work-items/anomaly-detect.js";
import { currentApproval } from "../work-items/approvals.js";
import { listWorkItemRuns } from "../work-items/runs.js";
import { getWorkItem } from "../work-items/store.js";
import { parseTodoApprovalRef } from "../workflows/todo-approval-ref.js";
import { availabilityRearm } from "./availability-resume.js";
import { workflowTodoLifecycle } from "./workflow-todo-surface.js";
import type { WorkflowRepository } from "../workflows/repository.js";

const DEFAULT_INTERVAL_MS = 5 * 60_000;

/**
 * Classify (and, if enabled, apply) bounded Todo recovery. Default mode is
 * classify-only so production observes lanes without auto-rearming until the
 * reviewed gate flips `gateway.todoRecovery.mode` to `auto`.
 */
export function closeApprovedLanded(todoId: string): boolean {
  const approval = currentApproval(todoId);
  if (approval?.state !== "approved" || !approval.decidedBy || !approval.decidedAt) return false;
  const origin = parseTodoApprovalRef(approval.ref);
  if (!origin) return false;
  const landed = listWorkItemRuns(todoId).some((run) => run.outcome === "completed" && run.endedAt !== null);
  if (!landed) return false;
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
      const anomalies = detectTodoAnomalies({ persist: true, closeApprovedLanded });
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
