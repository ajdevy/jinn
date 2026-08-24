import { currentApproval } from "./approval-rows.js";
import { listWorkItemEvents } from "./event-log.js";
import { classifyWorkItem } from "./recovery-controller.js";
import { getWorkItemRecovery, upsertWorkItemRecovery } from "./recovery-rows.js";
import {
  TODO_RECOVERY_ACTOR,
  type AttentionLane,
} from "./recovery.js";
import { listWorkItemRuns } from "./runs.js";
import { appendWorkItemEvent, getWorkItem, listWorkItems, type WorkItem } from "./store.js";
import { owningWorkflowId } from "./workflow-ownership.js";

export const ANOMALY_KINDS = [
  "assigned-without-run",
  "execution-timeout",
  "approved-landed-open",
  "review-without-reviewer",
  "blocked-without-recovery",
] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];

export interface TodoAnomaly {
  workItemId: string;
  kind: AnomalyKind;
  lane: AttentionLane;
  reason: string;
}

const EXECUTION_TIMEOUT_MS = 4 * 60 * 60_000;
const FRESH_RUN_MS = 15 * 60_000;

function alreadyObserved(workItemId: string, kind: AnomalyKind): boolean {
  return listWorkItemEvents(workItemId).some((event) =>
    event.kind === "anomaly_observed" && event.detail?.kind === kind);
}

function note(item: WorkItem, anomaly: TodoAnomaly, now: Date): void {
  if (alreadyObserved(item.id, anomaly.kind)) return;
  upsertWorkItemRecovery({
    workItemId: item.id,
    incidentId: `anomaly:${anomaly.kind}:${item.id}`,
    class: anomaly.lane === "recovering" ? "transient" : anomaly.lane === "manager" ? "code" : "operator",
    lane: anomaly.lane,
    reason: anomaly.reason,
    now,
  });
  appendWorkItemEvent({
    workItemId: item.id,
    kind: "anomaly_observed",
    actor: TODO_RECOVERY_ACTOR,
    detail: { kind: anomaly.kind, lane: anomaly.lane, reason: anomaly.reason },
    versionEffect: "audit",
  });
}

function inspect(item: WorkItem, now: Date): TodoAnomaly | undefined {
  const runs = listWorkItemRuns(item.id);
  const open = runs.filter((run) => run.endedAt === null);
  const last = [...runs].reverse().find((run) => run.endedAt !== null);
  const approval = currentApproval(item.id);
  const owner = owningWorkflowId(item.id);

  if (item.status === "assigned" && open.length === 0 && owner) {
    const fresh = last?.endedAt && now.getTime() - Date.parse(last.endedAt) < FRESH_RUN_MS;
    if (!fresh) {
      return {
        workItemId: item.id, kind: "assigned-without-run", lane: "recovering",
        reason: "assigned to a pipeline with no active run",
      };
    }
  }

  if (item.status === "executing" && open.length > 0) {
    const started = Date.parse(open[0]!.startedAt);
    if (Number.isFinite(started) && now.getTime() - started > EXECUTION_TIMEOUT_MS) {
      return {
        workItemId: item.id, kind: "execution-timeout", lane: "manager",
        reason: "execution has outlived the 4h timeout without an in-flight session to speak for it",
      };
    }
  }

  if (item.status === "in_review" && approval?.state === "approved" && last?.outcome === "completed") {
    return {
      workItemId: item.id, kind: "approved-landed-open", lane: "manager",
      reason: "approved landing is still open",
    };
  }

  if (item.status === "in_review" && approval?.state !== "pending" && !item.assignee) {
    return {
      workItemId: item.id, kind: "review-without-reviewer", lane: "manager",
      reason: "in review with no pending approval and no reviewer",
    };
  }

  if (item.status === "blocked" && !getWorkItemRecovery(item.id)) {
    const verdict = classifyWorkItem(item);
    if (verdict.lane !== "operator") {
      return {
        workItemId: item.id, kind: "blocked-without-recovery", lane: verdict.lane,
        reason: "blocked with no recovery row",
      };
    }
  }

  return undefined;
}

/**
 * Quiet detector. Returns the leftover lies on the board. A healthy board
 * returns []. Never creates a Todo or a session.
 */
export function detectTodoAnomalies(now = new Date(), persist = true): TodoAnomaly[] {
  const found: TodoAnomaly[] = [];
  for (const status of ["assigned", "executing", "in_review", "blocked"] as const) {
    for (const item of listWorkItems({ status })) {
      const anomaly = inspect(item, now);
      if (!anomaly) continue;
      found.push(anomaly);
      if (persist) note(item, anomaly, now);
    }
  }
  return found;
}

export function detectAnomalyFor(id: string, now = new Date()): TodoAnomaly | undefined {
  const item = getWorkItem(id);
  return item ? inspect(item, now) : undefined;
}
