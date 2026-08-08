import type { Employee, EngineSessionRef, Session } from "../../shared/types.js";
import {
  completeSessionAttempt,
  recordEngineSessionId,
  recordTurnAccounting,
  updateSessionForAttempt,
  type UpdateSessionFields,
} from "../registry.js";
import { notifyParentSession } from "../callbacks.js";
import type { TurnSurface } from "./types.js";

/** The three ways a turn can end. Anything else is not terminal. */
export type TurnOutcome = "succeeded" | "failed" | "interrupted";

export interface SettleTurnInput {
  sessionId: string;
  attemptToken: string;
  outcome: TurnOutcome;
  result?: string | null;
  error?: string | null;
  cost?: number;
  durationMs?: number;
  /**
   * This turn's cost/turn delta. Present whenever an engine actually ran —
   * including a rate-limit fallback or retry, because a recovered turn is still
   * a turn. Absent only for aborts that never reached an engine.
   */
  accounting?: { cost?: number; numTurns?: number };
  /** Native engine-session id filed before the receipt, so a resume finds it. */
  engineSession?: { engine: string; nativeId: string; meta?: Omit<EngineSessionRef, "id"> };
  /** Transport fields folded into the same write as the receipt. */
  fields?: UpdateSessionFields;
  /**
   * Statuses the attempt may settle from. The default running-only fence is
   * what makes an interrupted row immutable to a late success; the rate-limit
   * timeout widens it because that turn settles out of `waiting`.
   */
  expectedStatuses?: readonly Session["status"][];
  employee?: Employee;
  /** Interrupted turns stay silent: whoever interrupted already reported it. */
  notifyParent?: boolean;
  surface: TurnSurface;
}

const STATUS_FOR_OUTCOME: Record<TurnOutcome, Session["status"]> = {
  succeeded: "idle",
  failed: "error",
  interrupted: "interrupted",
};

/**
 * The single completion path. Every terminal receipt in every runner is written
 * here, in this fixed order: file the engine session, account for the turn,
 * write the receipt, wake the parent, tell the transport.
 *
 * It exists because two runners each grew their own copy of that sequence and
 * drifted — one of them silently skipped accounting, which disabled employee
 * budget caps for the majority of turns. Adding a completion site anywhere else
 * re-opens exactly that hole.
 *
 * Returns the settled session, or undefined when a stop, reset, or newer turn
 * has already taken ownership of the attempt.
 */
export async function settleTurn(input: SettleTurnInput): Promise<Session | undefined> {
  const settledAt = new Date().toISOString();
  if (input.engineSession) {
    const { engine, nativeId, meta } = input.engineSession;
    recordEngineSessionId(input.sessionId, engine, nativeId, { ...meta, lastSyncedAt: settledAt });
  }
  if (input.accounting) recordTurnAccounting(input.sessionId, input.accounting);

  const settled = writeReceipt(input, settledAt);
  if (!settled) return undefined;

  const report = {
    result: input.result ?? null,
    error: input.error ?? null,
    cost: input.cost,
    durationMs: input.durationMs,
  };
  if (input.notifyParent !== false) {
    notifyParentSession(settled, report, { alwaysNotify: input.employee?.alwaysNotify });
  }
  await input.surface.settled({ session: settled, ...report });
  return settled;
}

/** The one fenced write that makes a turn terminal. */
function writeReceipt(input: SettleTurnInput, settledAt: string): Session | undefined {
  const fields: UpdateSessionFields = {
    ...input.fields,
    status: STATUS_FOR_OUTCOME[input.outcome],
    attemptOutcome: input.outcome,
    lastActivity: settledAt,
    lastError: input.error ?? (input.outcome === "interrupted" ? "Interrupted" : null),
  };
  return input.expectedStatuses
    ? updateSessionForAttempt(input.sessionId, input.attemptToken, fields, input.expectedStatuses)
    : completeSessionAttempt(input.sessionId, input.attemptToken, fields);
}
