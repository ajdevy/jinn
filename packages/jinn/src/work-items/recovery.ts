import { classifyEngineFailureText, hasEngineFailureClass } from "../shared/engine-failure.js";

/**
 * Bounded recovery classification (PLA-240).
 *
 * A verdict here is not an action. The controller decides whether to re-arm,
 * route, or leave the Todo on Needs you. Classification must be pure: the
 * replay suite feeds it historical incidents with no database of their own.
 */

export const RECOVERY_CLASSES = [
  "transient",
  "code",
  "verification",
  "security",
  "operator",
] as const;
export type RecoveryClass = (typeof RECOVERY_CLASSES)[number];

export const ATTENTION_LANES = ["recovering", "manager", "operator"] as const;
export type AttentionLane = (typeof ATTENTION_LANES)[number];

export const TODO_RECOVERY_ACTOR = "todo-recovery";
export const MAX_RECOVERY_ATTEMPTS = 2;

export interface RecoveryClassification {
  class: RecoveryClass;
  lane: AttentionLane;
  reason: string;
  owningWorkflowId?: string;
}

export interface RecoveryIncidentInput {
  todo: { id: string; status: string; assignee: string | null; source: string };
  lastRun?: { id: string; outcome: string; error: string | null; endedAt: string | null };
  openRun?: boolean;
  approval?: { state: string; operatorOnly: boolean };
  labels: string[];
  verifyMode?: "trust" | "verify" | "thorough";
  owningWorkflowId?: string;
}

const AVAILABILITY_CLASSES = ["quota", "rate-limit", "provider-outage", "network"] as const;
const VERIFY_FAILURE = /independent review|verifier rejected|verification failed|review rejected the diff/i;

function verdict(input: RecoveryIncidentInput, value: RecoveryClassification): RecoveryClassification {
  return input.owningWorkflowId === undefined ? value : { ...value, owningWorkflowId: input.owningWorkflowId };
}

function isAvailability(input: RecoveryIncidentInput, error: string): boolean {
  return input.lastRun?.outcome === "rate_limited"
    || hasEngineFailureClass(classifyEngineFailureText(error), ...AVAILABILITY_CLASSES);
}

function isVerificationFailure(input: RecoveryIncidentInput, error: string): boolean {
  return (input.verifyMode === "verify" || input.verifyMode === "thorough") && VERIFY_FAILURE.test(error);
}

function classifyFromFailure(input: RecoveryIncidentInput): RecoveryClassification | undefined {
  const error = input.lastRun?.error ?? "";
  if (hasEngineFailureClass(classifyEngineFailureText(error), "auth-terminal")) {
    return { class: "security", lane: "manager", reason: "credentials or auth failed; a clock retry cannot fix it" };
  }
  if (isAvailability(input, error)) {
    return { class: "transient", lane: "recovering", reason: "provider availability; resume the owning workflow when the window reopens" };
  }
  if (isVerificationFailure(input, error)) {
    return { class: "verification", lane: "manager", reason: "independent verification rejected the work" };
  }
  if (input.lastRun && ["crashed", "failed", "blocked", "timed_out", "abandoned"].includes(input.lastRun.outcome)) {
    return { class: "code", lane: "manager", reason: "the attempt failed in the work itself" };
  }
  return undefined;
}

function classifyLeftover(input: RecoveryIncidentInput): RecoveryClassification | undefined {
  if (input.approval?.state === "pending") {
    return { class: "operator", lane: "manager", reason: "a routed approval is waiting on an employee, not the operator" };
  }
  if (input.todo.status === "in_review" && input.approval?.state === "approved" && input.lastRun?.outcome === "completed") {
    return { class: "operator", lane: "manager", reason: "approved landing is still open" };
  }
  return undefined;
}

export function classifyRecovery(input: RecoveryIncidentInput): RecoveryClassification {
  if (input.todo.status === "backlog") {
    return verdict(input, { class: "operator", lane: "operator", reason: "ordinary backlog work is never auto-started" });
  }
  if (input.approval?.state === "pending" && input.approval.operatorOnly) {
    return verdict(input, { class: "operator", lane: "operator", reason: "operator-only approval is a genuine authority decision" });
  }
  const fromFailure = classifyFromFailure(input);
  if (fromFailure) return verdict(input, fromFailure);
  const leftover = classifyLeftover(input);
  if (leftover) return verdict(input, leftover);
  return verdict(input, { class: "operator", lane: "operator", reason: "no safe automatic recovery is known" });
}

/** Additive: never a column on `work_items`. The exact-shape verifier refuses
 *  drift in an existing table, so a new table is the only extension a deployed
 *  database can survive. */
export const WORK_ITEM_RECOVERY_DDL = `
CREATE TABLE IF NOT EXISTS work_item_recovery (
  work_item_id     TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
  incident_id      TEXT NOT NULL,
  class            TEXT NOT NULL CHECK (class IN ('transient','code','verification','security','operator')),
  lane             TEXT NOT NULL CHECK (lane IN ('recovering','manager','operator')),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 2),
  last_attempt_at  TEXT,
  last_run_id      TEXT,
  reason           TEXT NOT NULL,
  updated_at       TEXT NOT NULL
)`;

export interface WorkItemRecovery {
  workItemId: string;
  incidentId: string;
  class: RecoveryClass;
  lane: AttentionLane;
  attempts: number;
  lastAttemptAt: string | null;
  lastRunId: string | null;
  reason: string;
  updatedAt: string;
}

export interface UpsertRecoveryInput {
  workItemId: string;
  incidentId: string;
  class: RecoveryClass;
  lane: AttentionLane;
  reason: string;
  lastRunId?: string | null;
  /** When true, increment attempts for the same incident (capped at 2). A new
   *  incident_id starts at 0. */
  attempted?: boolean;
  now?: Date;
}
