import { logger } from "../../shared/logger.js";
import { markTranscriptSyncedThrough } from "../../gateway/external-turns.js";
import {
  clearEngineSessionRefs,
  deletePartialMessages,
  getSession,
  insertMessage,
  insertMessageAfter,
  updateSession,
  type UpdateSessionFields,
} from "../registry.js";
import { settleTurn, type SettleTurnInput } from "./completion.js";
import type { EngineAttempt } from "./engine-run.js";
import { withSyncMarkersCleared } from "./preflight.js";
import {
  clearSupersededTurnMeta,
  retainUnseenInterruptedPrompt,
  withUnseenInterruptedPromptsCleared,
} from "./superseded.js";
import { shouldPersistFinalAssistantMessage, turnDisplayText } from "./text.js";
import type { TurnInput, TurnRun, TurnSurface } from "./types.js";

/** Preflight refused: record the reason everywhere the turn would have landed. */
export async function settleRefusedTurn(
  input: TurnInput,
  surface: TurnSurface,
  error: string,
  terminalFields: () => UpdateSessionFields,
): Promise<void> {
  logger.error(`Session ${input.session.id} blocked: ${error}`);
  insertMessage(input.session.id, "assistant", `⛔ ${error}`);
  await settleTurn({
    sessionId: input.session.id,
    attemptToken: input.attemptToken,
    outcome: "failed",
    error,
    fields: terminalFields(),
    employee: input.employee,
    surface,
  });
  await surface.reply(`⛔ ${error}`);
}

/** What the runner observed about how this turn ended, beyond its result. */
export interface TurnVerdict {
  quietPreempted: boolean;
  streamedThrough: number;
  /** A newer user message displaced this turn. */
  superseded: boolean;
  /** The engine got far enough to have this turn's prompt in its own transcript. */
  enginePromptRead: boolean;
}

/** Settle a turn that reached the engine, whether or not its answer is wanted. */
export async function settleAnsweredTurn(
  run: TurnRun,
  attempt: EngineAttempt,
  model: string | undefined,
  verdict: TurnVerdict,
): Promise<void> {
  const sessionId = run.input.session.id;
  const { engineName } = run.plan;
  const result = attempt.result;
  const { quietPreempted } = verdict;

  const displayText = quietPreempted ? "" : turnDisplayText(result.result, result.error);
  if (shouldPersistFinalAssistantMessage({ resultText: result.result, quietPreempted }) || displayText) {
    insertMessageAfter(sessionId, "assistant", displayText, verdict.streamedThrough);
  }

  const settled = await settleTurn({
    ...answeredReceipt(run, attempt, model, verdict),
    surface: run.surface,
  });

  holdPromptTheEngineNeverRead(run, verdict);
  if (!quietPreempted && engineName === "claude") markTranscriptSyncedThrough(sessionId, result.sessionId);
  clearSupersededTurnMeta(sessionId);
  if (settled && displayText) await run.surface.reply(displayText);

  logger.info(
    `Session ${sessionId} completed` +
    (result.durationMs ? ` in ${result.durationMs}ms` : "") +
    (result.cost ? ` ($${result.cost.toFixed(4)})` : ""),
  );
}

/**
 * A newer message can cut a turn off before the engine reads its prompt, which
 * leaves the engine with no record of it at all. Hold it for the next turn to
 * carry, or it is lost from the conversation the engine sees.
 */
function holdPromptTheEngineNeverRead(run: TurnRun, verdict: TurnVerdict): void {
  if (!verdict.superseded || verdict.enginePromptRead) return;
  retainUnseenInterruptedPrompt(run.input.session.id, run.input.prompt);
}

/** The receipt a turn that reached the engine writes, preempted or not. */
function answeredReceipt(
  run: TurnRun,
  attempt: EngineAttempt,
  model: string | undefined,
  verdict: TurnVerdict,
): Omit<SettleTurnInput, "surface"> {
  const { quietPreempted } = verdict;
  const result = attempt.result;
  const answered = !quietPreempted && !result.error;
  return {
    sessionId: run.input.session.id,
    attemptToken: run.input.attemptToken,
    outcome: quietPreempted ? "interrupted" : (result.error ? "failed" : "succeeded"),
    result: quietPreempted ? null : result.result,
    error: quietPreempted ? null : (result.error ?? null),
    cost: result.cost,
    durationMs: result.durationMs,
    accounting: result,
    ...(answered ? filedEngineSession(run, attempt, model) : {}),
    fields: buildTerminalFields(run, result.contextTokens, verdict),
    employee: run.input.employee,
    // An interrupted turn stays silent upward: whoever interrupted it reports.
    notifyParent: !quietPreempted,
  };
}

/**
 * The engine session a successful turn files for the next resume. Falling back
 * to the id we resumed from keeps a turn that answered without echoing its own
 * session id from orphaning the engine session it actually used.
 */
function filedEngineSession(
  run: TurnRun,
  attempt: EngineAttempt,
  model: string | undefined,
): Pick<SettleTurnInput, "engineSession"> {
  const nativeId = attempt.result.sessionId?.trim() || run.plan.resumeNativeId;
  if (!nativeId) return {};
  return {
    engineSession: {
      engine: run.plan.engineName,
      nativeId,
      meta: { model, effortLevel: run.plan.effortLevel, platformContextFingerprint: attempt.fingerprint },
    },
  };
}

/** The turn threw: settle it as failed. The caller has confirmed it can land. */
export async function settleThrownTurn(run: TurnRun, errMsg: string): Promise<void> {
  const sessionId = run.input.session.id;
  deletePartialMessages(sessionId);
  await settleTurn({
    sessionId,
    attemptToken: run.input.attemptToken,
    outcome: "failed",
    error: errMsg,
    fields: run.terminalFields(),
    employee: run.input.employee,
    surface: run.surface,
  });
  await run.surface.reply(`Error: ${errMsg}`);
}

function buildTerminalFields(run: TurnRun, contextTokens: number | undefined, verdict: TurnVerdict): UpdateSessionFields {
  const fields: UpdateSessionFields = { ...run.terminalFields() };
  if (typeof contextTokens === "number") fields.lastContextTokens = contextTokens;
  const clearSyncMarkers = run.plan.syncRequested && !verdict.quietPreempted;
  // The held prompts this turn put in front of the engine are owed no longer,
  // and only the engine having read them settles that.
  const clearCarriedPrompts = run.plan.carriedInterruptedPrompts && verdict.enginePromptRead;
  if (clearSyncMarkers || clearCarriedPrompts) {
    let meta: unknown = fields.transportMeta ?? getSession(run.input.session.id)?.transportMeta;
    if (clearSyncMarkers) meta = withSyncMarkersCleared(meta);
    if (clearCarriedPrompts) meta = withUnseenInterruptedPromptsCleared(meta);
    fields.transportMeta = meta as UpdateSessionFields["transportMeta"];
  }
  return fields;
}

/**
 * A stale engine-session id makes every resume fail. Drop this engine's typed ref
 * so the next attempt starts a fresh engine session instead of retrying a dead one,
 * and drop any rate-limit override that would otherwise restore the dead id.
 */
export function clearDeadEngineSession(sessionId: string, engineName: string): void {
  logger.warn(`Dead session detected for ${sessionId} — clearing stale engine IDs`);
  const meta = { ...(getSession(sessionId)?.transportMeta || {}) } as Record<string, unknown>;
  delete meta["engineOverride"];
  clearEngineSessionRefs(sessionId, engineName);
  updateSession(sessionId, { transportMeta: meta as UpdateSessionFields["transportMeta"] });
}
