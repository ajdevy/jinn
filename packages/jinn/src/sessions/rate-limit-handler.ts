/**
 * Shared rate-limit / fallback / wait-and-retry handler.
 *
 * Both the connector path (sessions/manager.ts → runSession) and the web path
 * (gateway/api.ts → runWebSession) need to:
 *   1. Detect an engine usage-limit response.
 *   2. Hand the turn to the first usable engine in the limited engine's fallback chain.
 *   3. Otherwise enter a "waiting" loop: sleep until the reset window, retry on the same engine,
 *      keep the session's lastActivity heartbeat fresh, and loop again if still limited.
 *   4. Bail out when the deadline passes without recovery.
 *
 * The state machine, engine invocations, retry math, heartbeat cadence, deadline
 * computation, and `transportMeta.engineOverride` bookkeeping are identical between
 * the two call sites — only the transport-side UI/notification details differ.
 * This module owns the common bits; per-transport behavior is injected via hooks.
 *
 * Per-engine thread ids live in the typed `engineSessions` refs the registry owns
 * (read with getEngineSessionRef, written with nextEngineSessionFields folded into
 * this module's existing attempt fences) — never in a transport-meta blob.
 *
 * Behavior is intentionally preserved verbatim from the original inlined
 * implementations — do not "improve" the wait math, the per-step state writes,
 * or the order of side effects without auditing both call sites.
 */

import type { Employee, Engine, EngineResult, JinnConfig, ResolvedMcpConfig, Session, StreamDelta } from "../shared/types.js";
import { JINN_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { resolveEffort } from "../shared/effort.js";
import { effortLevelsForModel, engineAvailable, type EngineName } from "../shared/models.js";
import { computeNextRetryDelayMs, computeRateLimitDeadlineMs, detectRateLimit, rateLimitEngineLabel } from "../shared/rateLimit.js";
import { recordClaudeRateLimit } from "../shared/usageAwareness.js";
import { resolveFallbackEngine } from "../shared/engine-fallback.js";
import { resolveEngineRunMcp } from "./engine-run-mcp.js";
import { getSession, getMessages, updateSessionForAttempt, getEngineSessionRef, nextEngineSessionFields } from "./registry.js";
import { runtimeSessionSource } from "./context.js";

const WAIT_CANCEL_POLL_MS = 5000;

/** What detectRateLimit returned for the original turn. */
export interface RateLimitInfo {
  /** Unix timestamp (seconds) when the limit is expected to reset, if known. */
  resetsAt?: number;
}

/** Outcome categories returned by handleRateLimit so callers can drive transport-side completion. */
export type RateLimitOutcome =
  | { kind: "fallback"; result: EngineResult }
  | { kind: "resumed"; result: EngineResult }
  | { kind: "timeout" }
  | { kind: "cancelled" };

export interface RateLimitHandlerHooks {
  /**
   * Called when entering the fallback branch (before the substitute engine runs).
   * Use this to: notify the user we're switching engines (UI message, Discord, etc.).
   */
  onFallbackStart?: (info: { resumeAt: Date | null; until: Date }) => void | Promise<void>;

  /**
   * Optional stream callback for the fallback engine's run (web emits deltas here).
   */
  onFallbackStream?: (delta: StreamDelta) => void;

  /**
   * Called after the fallback engine finishes, before the handler returns.
   * The persistence of the assistant message and any "completed" event emission
   * is done here (caller-specific).
   */
  onFallbackComplete?: (result: EngineResult) => void | Promise<void>;

  /**
   * Called once when entering the wait-and-retry loop. Use this to: switch UI
   * to "waiting", post a "I'll continue automatically" message, notify Discord, etc.
   */
  onWaitingStart?: (info: { resumeAt: Date | null; rateLimit: RateLimitInfo }) => void | Promise<void>;

  /**
   * Called each retry iteration BEFORE the retry engine.run — switch UI back
   * to "thinking" state.
   */
  onRetryAttempt?: (info: { attempt: number }) => void | Promise<void>;

  /**
   * Called each iteration when the retry was STILL rate-limited — switch UI
   * back to "waiting" state, log, etc.
   */
  onStillLimited?: (info: { attempt: number; resumeAt: Date | null }) => void | Promise<void>;

  /**
   * Optional stream callback for the retry engine's run (web emits deltas).
   */
  onRetryStream?: (delta: StreamDelta) => void;

  /**
   * Called when a retry succeeds (or fails with a non-rate-limit error).
   * Persist the assistant message + emit completion event here.
   */
  onRetrySuccess?: (result: EngineResult) => void | Promise<void>;

  /**
   * Called when the deadline expires before the limit clears. Notify the user,
   * mark session errored, emit completion event with the timeout error.
   */
  onTimeout?: () => void | Promise<void>;

  /**
   * Called when the session was deleted/cancelled while waiting. The handler
   * has already returned — this is just a hook to log or emit cleanup.
   */
  onCancelled?: () => void | Promise<void>;
}

export interface RateLimitHandlerOpts {
  session: Session;
  /** Generation token minted when this turn entered running state. */
  attemptToken: string;
  /** The original prompt that hit the rate limit — used unchanged for retries. */
  prompt: string;
  systemPrompt?: string;
  /** Explicit refresh for retries on the same resumed native transcript. Never
   *  forwarded to a different fallback engine. */
  platformContextRefresh?: string;
  /** Engine config used by the original turn (bin + model + …). */
  engineConfig: { bin?: string; model?: string };
  effortLevel?: string;
  /** Optional employee-level CLI flag overrides (passed to retry engine.run calls). */
  cliFlags?: string[];
  /** Path to MCP config JSON file, if applicable to the original turn. */
  mcpConfigPath?: string;
  /** In-memory resolved MCP server set from the original turn (preserved on retry
   *  so the payload is not silently dropped; a substitute engine resolves its own). */
  resolvedMcp?: ResolvedMcpConfig;
  /** Optional attachment file paths from the original turn (preserved on retry). */
  attachments?: string[];
  /** The current jinn config (used to look up the fallback chain + the substitute's engine config). */
  config: JinnConfig;
  /** Map of available engines (for substitute lookup). */
  engines: Map<string, Engine>;
  /** Optional employee record (for substitute effort + cliFlags). */
  employee?: Employee;
  /** The engine used for retries — the engine that returned the rate-limited result. */
  engine: Engine;
  /** Result of detectRateLimit() on the original turn. */
  rateLimit: RateLimitInfo;
  /** The original failed result — used for its sessionId field when recording the engine's thread id. */
  originalResult: EngineResult;
  hooks: RateLimitHandlerHooks;
}

/**
 * Drive the rate-limit recovery state machine. Returns once the situation
 * resolves (success, fallback completion, timeout, or cancellation).
 *
 * The caller has ALREADY detected the rate limit and confirmed it should be
 * handled (i.e. not a dead session, not an interrupted turn).
 */
export async function handleRateLimit(opts: RateLimitHandlerOpts): Promise<RateLimitOutcome> {
  const {
    session, attemptToken, prompt, systemPrompt, platformContextRefresh, engineConfig, effortLevel, cliFlags,
    mcpConfigPath, resolvedMcp, attachments, config, engines, employee, engine,
    rateLimit, originalResult, hooks,
  } = opts;

  const engineLabel = rateLimitEngineLabel(session.engine);

  // Only Claude has a global usage-awareness store to record limits against.
  if (session.engine === "claude") recordClaudeRateLimit(rateLimit.resetsAt);

  // ── Branch A: hand the turn to this engine's chain ─────────────────────────
  const isUsable = (candidate: EngineName) => engines.has(candidate) && engineAvailable(config, candidate);
  const substituteName = resolveFallbackEngine(config, session.engine, isUsable);
  const substituteEngine = substituteName ? engines.get(substituteName) : undefined;
  if (substituteName && substituteEngine) {
    const { resumeAt } = computeNextRetryDelayMs(rateLimit.resetsAt);
    const until = resumeAt ?? new Date(Date.now() + 6 * 60 * 60_000);
    const syncSince = new Date().toISOString();
    const substituteLabel = rateLimitEngineLabel(substituteName);

    await hooks.onFallbackStart?.({ resumeAt: resumeAt ?? null, until });

    const nextMeta = { ...(session.transportMeta || {}) } as Record<string, unknown>;
    nextMeta.engineOverride = {
      originalEngine: session.engine,
      originalEngineSessionId: session.engineSessionId,
      until: until.toISOString(),
      syncSince,
    };

    const fallbackStarted = updateSessionForAttempt(session.id, attemptToken, {
      // The limited engine's thread id moves to its own typed ref (the override record
      // keeps a second copy). The mirror belongs to whichever engine is actually running,
      // so it goes null until the substitute returns a thread id of its own.
      ...(session.engineSessionId ? nextEngineSessionFields(session, session.engine, session.engineSessionId) : {}),
      engine: substituteName,
      engineSessionId: null,
      transportMeta: nextMeta as any,
      status: "running",
      lastActivity: new Date().toISOString(),
      lastError: resumeAt
        ? `${engineLabel} usage limit — using ${substituteLabel} until ${resumeAt.toISOString()}`
        : `${engineLabel} usage limit — using ${substituteLabel} temporarily`,
    });
    if (!fallbackStarted) {
      await hooks.onCancelled?.();
      return { kind: "cancelled" };
    }

    const substituteConfig: { bin?: string; model?: string; effortLevel?: string; childEffortOverride?: string } =
      config.engines[substituteName] ?? {};
    const substituteEffort = resolveEffort(
      substituteConfig,
      session,
      employee,
      effortLevelsForModel(config, substituteName, substituteConfig.model),
    );
    const substituteResume = getEngineSessionRef(session, substituteName).id;
    const history = getMessages(session.id)
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`);
    const historyText = history.slice(-12).join("\n\n");
    const fallbackPrompt = substituteResume
      ? prompt
      : `Continue this conversation and respond to the last USER message.\n\nConversation so far:\n\n${historyText}`;

    const fallbackResult = await substituteEngine.run({
      prompt: fallbackPrompt,
      resumeSessionId: substituteResume,
      systemPrompt,
      cwd: JINN_HOME,
      // The substitute runs as itself: its own binary, its own configured model, and the
      // MCP payload resolved for it — the limited engine's model would be meaningless here.
      bin: substituteConfig.bin,
      model: substituteConfig.model,
      effortLevel: substituteEffort,
      cliFlags: employee?.cliFlags ?? cliFlags,
      ...resolveEngineRunMcp({ config, employee, engine: substituteName, sessionId: session.id }),
      attachments: attachments?.length ? attachments : undefined,
      sessionId: session.id,
      ...(hooks.onFallbackStream ? { onStream: hooks.onFallbackStream } : {}),
    });

    // Persist the substitute's thread id so future fallbacks can resume it —
    // and so the mirror stops lying about which engine the id belongs to.
    const live = getSession(session.id);
    if (live && fallbackResult.sessionId) {
      updateSessionForAttempt(session.id, attemptToken, nextEngineSessionFields(live, substituteName, fallbackResult.sessionId));
    }

    await hooks.onFallbackComplete?.(fallbackResult);

    return { kind: "fallback", result: fallbackResult };
  }
  // Nothing usable in the chain — fall through to wait-and-retry.

  // ── Branch B: wait-and-retry on the original engine ────────────────────────
  const { delayMs, resumeAt } = computeNextRetryDelayMs(rateLimit.resetsAt);
  const deadlineMs = computeRateLimitDeadlineMs(
    rateLimit.resetsAt,
    rateLimit.resetsAt ? 30 * 60_000 : 6 * 60 * 60_000,
  );

  logger.info(
    `Session ${session.id} hit ${engineLabel} usage limit — will auto-retry ${resumeAt ? `at ${resumeAt.toISOString()}` : `in ${Math.round(delayMs / 1000)}s`}`,
  );

  const enteredWaiting = updateSessionForAttempt(session.id, attemptToken, {
    ...(originalResult.sessionId?.trim() ? nextEngineSessionFields(session, session.engine, originalResult.sessionId) : {}),
    status: "waiting",
    lastActivity: new Date().toISOString(),
    lastError: resumeAt
      ? `${engineLabel} usage limit — resumes ${resumeAt.toISOString()}`
      : `${engineLabel} usage limit — waiting for reset`,
  });
  if (!enteredWaiting) {
    await hooks.onCancelled?.();
    return { kind: "cancelled" };
  }

  await hooks.onWaitingStart?.({ resumeAt: resumeAt ?? null, rateLimit });

  // Keep lastActivity fresh while waiting (UI / status endpoints).
  const heartbeat = setInterval(() => {
    if (getSession(session.id)?.status === "waiting") {
      updateSessionForAttempt(session.id, attemptToken, { status: "waiting", lastActivity: new Date().toISOString() }, ["waiting"]);
    }
  }, 60_000);

  try {
    let attempt = 0;
    let nextDelayMs = delayMs;

    while (Date.now() < deadlineMs) {
      const stillWaiting = await waitWhileSessionWaiting(session.id, nextDelayMs);
      if (!stillWaiting) {
        const currentSession = getSession(session.id);
        logger.info(`Session ${session.id} stopped while waiting for usage reset (status=${currentSession?.status ?? "deleted"})`);
        await hooks.onCancelled?.();
        return { kind: "cancelled" };
      }
      attempt++;

      // Check if session was stopped while waiting. We set status:"waiting"
      // before entering this loop, so any other status (idle from a user
      // POST /stop, error from a crash, etc.) means the user/system pulled
      // us out of the waiting state and we should NOT retry. Previously this
      // only caught "error", so user-initiated stop ("idle") leaked through
      // and the retry fired against a session the user thought was stopped.
      const currentSession = getSession(session.id);
      if (!currentSession || currentSession.status !== "waiting") {
        logger.info(`Session ${session.id} stopped while waiting for usage reset (status=${currentSession?.status ?? "deleted"})`);
        await hooks.onCancelled?.();
        return { kind: "cancelled" };
      }

      await hooks.onRetryAttempt?.({ attempt });
      logger.info(`Session ${session.id} retrying after usage limit (attempt ${attempt})`);

      const retryStarted = updateSessionForAttempt(session.id, attemptToken, {
        status: "running",
        lastActivity: new Date().toISOString(),
      }, ["waiting"]);
      if (!retryStarted) {
        await hooks.onCancelled?.();
        return { kind: "cancelled" };
      }

      const retryResult = await engine.run({
        prompt,
        resumeSessionId: currentSession.engineSessionId ?? undefined,
        systemPrompt,
        platformContextRefresh,
        cwd: JINN_HOME,
        bin: engineConfig.bin,
        model: currentSession.model ?? engineConfig.model,
        effortLevel,
        cliFlags,
        mcpConfigPath,
        resolvedMcp,
        attachments: attachments?.length ? attachments : undefined,
        sessionId: session.id,
        source: runtimeSessionSource(session.source),
        ...(hooks.onRetryStream ? { onStream: hooks.onRetryStream } : {}),
      });

      const retryInterrupted = retryResult.error?.startsWith("Interrupted");
      const retryRateLimit = !retryInterrupted ? detectRateLimit(retryResult) : { limited: false as const };

      if (retryRateLimit.limited) {
        if (session.engine === "claude") {
          recordClaudeRateLimit(retryRateLimit.resetsAt);
        }
        logger.info(`Session ${session.id} still rate limited (attempt ${attempt})`);

        const next = computeNextRetryDelayMs(retryRateLimit.resetsAt);
        nextDelayMs = next.delayMs;

        const waitingAgain = updateSessionForAttempt(session.id, attemptToken, {
          ...(retryResult.sessionId?.trim() ? nextEngineSessionFields(currentSession, currentSession.engine, retryResult.sessionId) : {}),
          status: "waiting",
          lastActivity: new Date().toISOString(),
          lastError: next.resumeAt
            ? `${engineLabel} usage limit — resumes ${next.resumeAt.toISOString()}`
            : `${engineLabel} usage limit — waiting for reset`,
        });
        if (!waitingAgain) {
          await hooks.onCancelled?.();
          return { kind: "cancelled" };
        }

        await hooks.onStillLimited?.({ attempt, resumeAt: next.resumeAt ?? null });
        continue;
      }

      // Success (or non-rate-limit error) — hand off to caller for persistence + transport.
      await hooks.onRetrySuccess?.(retryResult);
      logger.info(`Session ${session.id} resumed after usage reset`);
      return { kind: "resumed", result: retryResult };
    }

    // Deadline exhausted without recovery.
    await hooks.onTimeout?.();
    logger.warn(`Session ${session.id} exhausted usage limit retries`);
    return { kind: "timeout" };
  } finally {
    clearInterval(heartbeat);
  }
}

async function waitWhileSessionWaiting(sessionId: string, delayMs: number): Promise<boolean> {
  const end = Date.now() + Math.max(0, delayMs);
  while (Date.now() < end) {
    const currentSession = getSession(sessionId);
    if (!currentSession || currentSession.status !== "waiting") return false;
    const sleepMs = Math.min(WAIT_CANCEL_POLL_MS, end - Date.now());
    if (sleepMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
  }
  const currentSession = getSession(sessionId);
  return !!currentSession && currentSession.status === "waiting";
}
