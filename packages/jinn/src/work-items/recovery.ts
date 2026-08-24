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

export function classifyRecovery(input: RecoveryIncidentInput): RecoveryClassification {
  const owner = input.owningWorkflowId;
  const withOwner = (verdict: RecoveryClassification): RecoveryClassification =>
    owner === undefined ? verdict : { ...verdict, owningWorkflowId: owner };

  if (input.todo.status === "backlog") {
    return withOwner({
      class: "operator",
      lane: "operator",
      reason: "ordinary backlog work is never auto-started",
    });
  }

  if (input.approval?.state === "pending" && input.approval.operatorOnly) {
    return withOwner({
      class: "operator",
      lane: "operator",
      reason: "operator-only approval is a genuine authority decision",
    });
  }

  const error = input.lastRun?.error ?? "";
  const failure = classifyEngineFailureText(error);

  if (hasEngineFailureClass(failure, "auth-terminal")) {
    return withOwner({
      class: "security",
      lane: "manager",
      reason: "credentials or auth failed; a clock retry cannot fix it",
    });
  }

  const availability =
    input.lastRun?.outcome === "rate_limited"
    || hasEngineFailureClass(failure, ...AVAILABILITY_CLASSES);
  if (availability && input.todo.status !== "backlog") {
    return withOwner({
      class: "transient",
      lane: "recovering",
      reason: "provider availability; resume the owning workflow when the window reopens",
    });
  }

  if (
    (input.verifyMode === "verify" || input.verifyMode === "thorough")
    && VERIFY_FAILURE.test(error)
  ) {
    return withOwner({
      class: "verification",
      lane: "manager",
      reason: "independent verification rejected the work",
    });
  }

  if (input.lastRun && (input.lastRun.outcome === "crashed" || input.lastRun.outcome === "failed")) {
    return withOwner({
      class: "code",
      lane: "manager",
      reason: "the attempt failed in the work itself",
    });
  }

  if (input.approval?.state === "pending") {
    return withOwner({
      class: "operator",
      lane: "manager",
      reason: "a routed approval is waiting on an employee, not the operator",
    });
  }

  return withOwner({
    class: "operator",
    lane: "operator",
    reason: "no safe automatic recovery is known",
  });
}
