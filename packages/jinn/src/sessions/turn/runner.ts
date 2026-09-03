import { logger } from "../../shared/logger.js";
import { detectRateLimit, isDeadSessionError, rateLimitEngineLabel } from "../../shared/rateLimit.js";
import { isProviderFailure, resolveProviderFallback } from "../../shared/provider-fallback.js";
import { isInterruptibleEngine, type EngineResult, type Session } from "../../shared/types.js";
import { completedStreamedBlockIds } from "../../gateway/streamed-blocks.js";
import {
  deletePartialMessages,
  getPartialMessages,
  getSession,
  getEngineSessionRef,
  nextEngineSessionFields,
  settlePartialMessages,
  updateSession,
  updateSessionForAttempt,
  type UpdateSessionFields,
} from "../registry.js";
import { createPartialStreamWriter } from "../partial-stream.js";
import { isDurableWorkflowUserMessageInterruption } from "../workflow-interruptions.js";
import { runEngineAttempt, resolveModelFallback, type EngineAttempt } from "./engine-run.js";
import { armTurnHeartbeat } from "./heartbeat.js";
import { preflightTurn, warnIfNearUsageLimit } from "./preflight.js";
import { runRateLimitTurn } from "./rate-limit-turn.js";
import { clearDeadEngineSession, settleAnsweredTurn, settleRefusedTurn, settleThrownTurn } from "./settle.js";
import { clearSupersededTurnMeta, isTurnSuperseded } from "./superseded.js";
import type { TurnInput, TurnRun, TurnSurface } from "./types.js";

/**
 * Run one turn, from preflight to terminal receipt, for every transport.
 *
 * The caller has already begun the attempt and owns the queue slot; this owns
 * everything between. Both the connector runner and the web runner call it, and
 * the only thing they supply differently is the `TurnSurface`.
 */
export async function runTurn(input: TurnInput, surface: TurnSurface): Promise<void> {
  const sessionId = input.session.id;
  const terminalFields = (): UpdateSessionFields => input.terminalFields?.() ?? {};

  const plan = preflightTurn(input);
  if (!plan.ok) {
    await settleRefusedTurn(input, surface, plan.error, terminalFields);
    return;
  }

  logger.info(`Session ${sessionId} running engine "${plan.engineName}" (model: ${plan.model || "default"})`);
  await surface.started();
  await warnIfNearUsageLimit(input, plan, surface);

  const run: TurnRun = {
    input,
    plan,
    surface,
    heartbeat: armTurnHeartbeat(sessionId, input.attemptToken),
    partialStream: createPartialStreamWriter(sessionId),
    turnStartedAt: Date.now(),
    terminalFields,
  };

  try {
    const initial = await runEngineWithModelFallback(run);
    const execution = await runEngineWithProviderFallback(run, initial);
    execution.run.heartbeat.stop();
    await concludeTurn(execution.run, execution.attempt, execution.model);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Session ${sessionId} error: ${errMsg}`);
    if (claimSettleableSession(run, "error")) await settleThrownTurn(run, errMsg);
  } finally {
    run.heartbeat.stop();
  }
}

type EngineExecution = {
  run: TurnRun;
  attempt: EngineAttempt;
  model: string | undefined;
};

const PROVIDER_FALLBACK_COOLDOWN_MS = 15 * 60_000;

/** Switch once to the configured provider chain when a turn fails before streaming. */
async function runEngineWithProviderFallback(
  run: TurnRun,
  initial: { attempt: EngineAttempt; model: string | undefined },
): Promise<EngineExecution> {
  const result = initial.attempt.result;
  if (!isProviderFailure(result) || getPartialMessages(run.input.session.id).length > 0) {
    return { run, ...initial };
  }

  const live = getSession(run.input.session.id);
  const currentMeta = (live?.transportMeta || {}) as Record<string, unknown>;
  if (!live
    || live.engine !== run.plan.engineName
    || live.attemptToken !== run.input.attemptToken
    || live.status !== "running"
    || currentMeta.engineOverride) {
    return { run, ...initial };
  }

  const fallbackName = resolveProviderFallback(run.input.config, run.plan.engineName, run.input.engines);
  if (!fallbackName) return { run, ...initial };

  const fallbackConfig = (run.input.config.engines as unknown as Record<string, {
    bin?: string;
    model?: string;
    effortLevel?: string;
    childEffortOverride?: string;
  } | undefined>)[fallbackName] ?? {};
  const fallbackRef = getEngineSessionRef(live, fallbackName);
  const syncSince = new Date().toISOString();
  const until = new Date(Date.now() + PROVIDER_FALLBACK_COOLDOWN_MS);
  const nextMeta = {
    ...currentMeta,
    engineOverride: {
      originalEngine: live.engine,
      originalEngineSessionId: live.engineSessionId,
      originalModel: live.model,
      originalEffortLevel: live.effortLevel,
      until: until.toISOString(),
      syncSince,
    },
    engineSyncTarget: fallbackName,
    engineSyncSince: syncSince,
  };
  const parked = live.engineSessionId
    ? nextEngineSessionFields(live, live.engine, live.engineSessionId, {
      model: live.model ?? undefined,
      effortLevel: live.effortLevel ?? undefined,
    })
    : {};
  const fallbackModel = fallbackRef.model ?? fallbackConfig.model ?? null;
  const fallbackEffort = fallbackRef.effortLevel ?? fallbackConfig.effortLevel ?? null;
  const projected = {
    ...live,
    ...parked,
    engine: fallbackName,
    engineSessionId: fallbackRef.id ?? null,
    model: fallbackModel,
    effortLevel: fallbackEffort,
    transportMeta: nextMeta,
  };
  const fallbackPlan = preflightTurn({ ...run.input, session: projected, engineOverride: undefined });
  if (!fallbackPlan.ok) {
    logger.warn(`Provider fallback for session ${live.id} refused: ${fallbackPlan.error}`);
    return { run, ...initial };
  }

  const switched = updateSessionForAttempt(run.input.session.id, run.input.attemptToken, (current) => {
    if (current.engine !== run.plan.engineName) return {};
    return {
      ...parked,
      engine: fallbackName,
      engineSessionId: fallbackRef.id ?? null,
      model: fallbackModel,
      effortLevel: fallbackEffort,
      transportMeta: nextMeta as any,
      lastError: `${rateLimitEngineLabel(run.plan.engineName)} unavailable — using ${rateLimitEngineLabel(fallbackName)} temporarily`,
    };
  });
  if (!switched || switched.engine !== fallbackName || switched.attemptToken !== run.input.attemptToken) {
    return { run, ...initial };
  }

  logger.warn(`Session ${live.id} provider ${run.plan.engineName} failed; switching to ${fallbackName}`);
  if (isInterruptibleEngine(run.plan.engine)) {
    run.plan.engine.kill(live.id, "Interrupted: provider fallback");
  }
  await run.surface.notice(
    `⚠️ ${rateLimitEngineLabel(run.plan.engineName)} is temporarily unavailable. Switching to ${rateLimitEngineLabel(fallbackName)}.`,
  ).catch((err) => logger.warn(`Provider fallback notice failed: ${err instanceof Error ? err.message : String(err)}`));

  const fallbackInput = { ...run.input, session: switched, engineOverride: undefined };
  const fallbackRun: TurnRun = { ...run, input: fallbackInput, plan: fallbackPlan };
  const attempt = await runEngineAttempt({ ...fallbackRun, model: fallbackPlan.model });
  return { run: fallbackRun, attempt, model: fallbackPlan.model };
}

/** Run the engine, retrying once on a model Claude has since withdrawn. */
async function runEngineWithModelFallback(run: TurnRun): Promise<{ attempt: EngineAttempt; model: string | undefined }> {
  let model = run.plan.model;
  let attempt = await runEngineAttempt({ ...run, model });

  const retryModel = await resolveModelFallback(run.input, run.plan, attempt.result, model);
  if (retryModel) {
    deletePartialMessages(run.input.session.id);
    model = retryModel;
    updateSession(run.input.session.id, { model: retryModel, lastError: null });
    attempt = await runEngineAttempt({ ...run, model });
  }
  return { attempt, model };
}

/**
 * The session this turn belongs to, or undefined when the result no longer has
 * anywhere to land: the session was deleted, or it has since switched engines
 * and this answer came from the old one.
 */
function claimSettleableSession(run: TurnRun, what: "result" | "error"): Session | undefined {
  const sessionId = run.input.session.id;
  const live = getSession(sessionId);
  if (!live) {
    deletePartialMessages(sessionId);
    logger.warn(`Dropping engine ${what} for deleted session ${sessionId}`);
    return undefined;
  }
  if (live.engine !== run.plan.engineName) {
    deletePartialMessages(sessionId);
    clearSupersededTurnMeta(sessionId);
    logger.info(`Dropping stale ${run.plan.engineName} ${what} for session ${sessionId}; session now uses ${live.engine}`);
    return undefined;
  }
  return live;
}

/**
 * Was this turn's answer preempted before it could land? A newer user message,
 * a stop, a workflow interruption, or another turn taking the attempt all mean
 * the same thing: settle as interrupted and say nothing to anyone.
 */
function wasQuietlyPreempted(run: TurnRun, live: Session, result: EngineResult, superseded: boolean): boolean {
  const completionTurn = (live.attemptTurn ?? 0) + 1;
  if (isDurableWorkflowUserMessageInterruption(live, completionTurn)) return true;
  if (result.error?.startsWith("Interrupted")) return true;
  if (live.attemptToken !== run.input.attemptToken || live.status !== "running") return true;
  return superseded;
}

/** Settle whichever terminal class this turn landed in. */
async function concludeTurn(run: TurnRun, attempt: EngineAttempt, model: string | undefined): Promise<void> {
  const sessionId = run.input.session.id;
  const live = claimSettleableSession(run, "result");
  if (!live) return;

  const result = attempt.result;
  const superseded = isTurnSuperseded(sessionId, run.turnStartedAt);
  const quietPreempted = wasQuietlyPreempted(run, live, result, superseded);

  // A stale engine-session id can carry text like "429" that would otherwise
  // read as a rate limit, so dead sessions are cleared before that check.
  const dead = !quietPreempted && isDeadSessionError(result);
  if (dead) clearDeadEngineSession(sessionId, run.plan.engineName);
  const rateLimit = !quietPreempted && !dead ? detectRateLimit(result) : { limited: false as const };

  // Keep the same completed evidence the live view kept — interim prose, tools,
  // media, delegation blocks — and drop exact streamed copies of the result,
  // which the canonical final row replaces.
  const streamedBlocks = getPartialMessages(sessionId);
  settlePartialMessages(sessionId, completedStreamedBlockIds({
    quietPreempted,
    rateLimited: rateLimit.limited,
    result: result.result,
    error: result.error,
    streamedBlocks,
  }));

  if (rateLimit.limited) {
    await runRateLimitTurn({
      input: run.input,
      plan: run.plan,
      surface: run.surface,
      systemPrompt: attempt.systemPrompt,
      platformContextRefresh: attempt.contextRefresh,
      platformContextFingerprint: attempt.fingerprint,
      rateLimit,
      originalResult: result,
      terminalFields: run.terminalFields,
    });
    return;
  }

  const streamedThrough = streamedBlocks.reduce((latest, message) => Math.max(latest, message.timestamp), 0);
  // A turn killed before it emitted anything is one the engine never began, so
  // its prompt is absent from the engine's own transcript. Anything it did emit
  // proves the engine read the prompt and recorded it.
  const enginePromptRead = !quietPreempted || streamedBlocks.length > 0;
  await settleAnsweredTurn(run, attempt, model, { quietPreempted, streamedThrough, superseded, enginePromptRead });
}
