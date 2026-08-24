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
import { initDb } from "../shared/db.js";

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
  const incidentId = `anomaly:${anomaly.kind}:${item.id}`;
  const prior = getWorkItemRecovery(item.id);
  if (prior?.lane !== anomaly.lane || prior.incidentId !== incidentId) {
    upsertWorkItemRecovery({
      workItemId: item.id,
      incidentId,
      class: anomaly.lane === "recovering" ? "transient" : anomaly.lane === "manager" ? "code" : "operator",
      lane: anomaly.lane,
      reason: anomaly.reason,
      now,
    });
  }
  if (alreadyObserved(item.id, anomaly.kind)) return;
  appendWorkItemEvent({
    workItemId: item.id,
    kind: "anomaly_observed",
    actor: TODO_RECOVERY_ACTOR,
    detail: { kind: anomaly.kind, lane: anomaly.lane, reason: anomaly.reason },
    versionEffect: "audit",
  });
}

function assignedWithoutRun(item: WorkItem, now: Date): TodoAnomaly | undefined {
  if (item.status !== "assigned" || !owningWorkflowId(item.id)) return undefined;
  const runs = listWorkItemRuns(item.id);
  if (runs.some((run) => run.endedAt === null)) return undefined;
  const last = [...runs].reverse().find((run) => run.endedAt !== null);
  if (last?.endedAt && now.getTime() - Date.parse(last.endedAt) < FRESH_RUN_MS) return undefined;
  return { workItemId: item.id, kind: "assigned-without-run", lane: "recovering", reason: "assigned to a pipeline with no active run" };
}

function sessionInFlight(sessionId: string): boolean {
  const row = initDb().prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId) as { status: string } | undefined;
  return row?.status === "running" || row?.status === "waiting";
}

function executionTimeout(item: WorkItem, now: Date): TodoAnomaly | undefined {
  if (item.status !== "executing") return undefined;
  const open = listWorkItemRuns(item.id).find((run) => run.endedAt === null);
  if (!open) return undefined;
  if (sessionInFlight(open.sessionId)) return undefined;
  const started = Date.parse(open.startedAt);
  if (!Number.isFinite(started) || now.getTime() - started <= EXECUTION_TIMEOUT_MS) return undefined;
  return { workItemId: item.id, kind: "execution-timeout", lane: "manager", reason: "execution has outlived the 4h timeout without an in-flight session to speak for it" };
}

function reviewAnomaly(item: WorkItem, approvedLandingComplete?: (todoId: string) => boolean): TodoAnomaly | undefined {
  if (item.status !== "in_review") return undefined;
  const approval = currentApproval(item.id);
  if (approval?.state === "approved" && approvedLandingComplete?.(item.id)) {
    return { workItemId: item.id, kind: "approved-landed-open", lane: "manager", reason: "approved landing is still open" };
  }
  if (approval?.state !== "pending" && !item.assignee) {
    return { workItemId: item.id, kind: "review-without-reviewer", lane: "manager", reason: "in review with no pending approval and no reviewer" };
  }
  return undefined;
}

function blockedWithoutRecovery(item: WorkItem): TodoAnomaly | undefined {
  if (item.status !== "blocked" || getWorkItemRecovery(item.id)) return undefined;
  const verdict = classifyWorkItem(item);
  if (verdict.lane === "operator") return undefined;
  return { workItemId: item.id, kind: "blocked-without-recovery", lane: verdict.lane, reason: "blocked with no recovery row" };
}

function inspect(item: WorkItem, now: Date,
  approvedLandingComplete?: (todoId: string) => boolean): TodoAnomaly | undefined {
  return assignedWithoutRun(item, now) ?? executionTimeout(item, now)
    ?? reviewAnomaly(item, approvedLandingComplete) ?? blockedWithoutRecovery(item);
}

export interface DetectTodoAnomaliesInput {
  now?: Date;
  persist?: boolean;
  /** Exact Workflow-run proof that the approved landing completed. */
  approvedLandingComplete?: (todoId: string) => boolean;
  /** Close an approved-landed leftover through the existing complete() path.
   *  Return true when the Todo is done so it is not parked on Manager attention. */
  closeApprovedLanded?: (todoId: string) => boolean;
}

/**
 * Quiet detector. Returns the leftover lies on the board. A healthy board
 * returns []. Never creates a Todo or a session.
 */
export function detectTodoAnomalies(input: DetectTodoAnomaliesInput = {}): TodoAnomaly[] {
  const now = input.now ?? new Date();
  const persist = input.persist !== false;
  const found: TodoAnomaly[] = [];
  for (const status of ["assigned", "executing", "in_review", "blocked"] as const) {
    for (const item of listWorkItems({ status })) {
      const anomaly = inspect(item, now, input.approvedLandingComplete);
      if (!anomaly) continue;
      if (anomaly.kind === "approved-landed-open" && input.closeApprovedLanded?.(item.id)) {
        found.push(anomaly);
        continue;
      }
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
