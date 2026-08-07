/**
 * The in-memory registry of open talk sessions — one source of truth, keyed by
 * talk-session id.
 *
 * Nothing here is bound to a socket. A session survives a page navigation
 * because the client keeps its id and re-attaches; it dies with the tab because
 * a closed tab stops heartbeating and {@link TalkSessionRegistry.reap} collects
 * it. Sessions do not survive a gateway restart, which is the same death by a
 * blunter instrument.
 */
import { randomUUID } from "node:crypto";
import type { RealtimeTool } from "../../shared/types.js";
import {
  TALK_CONTEXT_BUDGET_TOKENS,
  contextTokens,
  estimateTokens,
  handoffSuggested,
  truncateTurns,
} from "./context.js";
import { alwaysOnTools, toolsForIntents } from "./tools.js";
import type { TalkSession, TalkTurnRecord } from "./types.js";

/** Three missed 30-second heartbeats. */
export const TALK_SESSION_TTL_MS = 90_000;

/** Carries the HTTP status the router should answer with, so state rules live
 *  here rather than being re-derived at every route. */
export class TalkSessionError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TalkSessionError";
    this.status = status;
  }
}

export interface OpenTalkSessionOptions {
  /** The `sessions` row this talk session bills through. */
  sessionId: string;
  model: string;
  /** Expiry of the credential minted for this open, in provider seconds. */
  tokenExpiresAt: number;
}

export interface TalkTurnResult {
  contextTokens: number;
  /** Cumulative over the session, not just this turn. */
  truncatedTurns: number;
  handoffSuggested: boolean;
}

export class TalkSessionRegistry {
  private readonly sessions = new Map<string, TalkSession>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  open(options: OpenTalkSessionOptions): TalkSession {
    const at = this.now();
    const session: TalkSession = {
      id: randomUUID(),
      sessionId: options.sessionId,
      state: "live",
      model: options.model,
      openedAt: at,
      lastSeenAt: at,
      turns: [],
      truncatedTurns: 0,
      tokenExpiresAt: options.tokenExpiresAt,
      exposedTools: alwaysOnTools().map((tool) => tool.name),
      expandedIntents: [],
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): TalkSession | undefined {
    return this.sessions.get(id);
  }

  park(id: string): TalkSession {
    const session = this.require(id);
    if (session.state === "parked") {
      throw new TalkSessionError(409, "This talk session is already parked.");
    }
    session.state = "parked";
    session.lastSeenAt = this.now();
    return session;
  }

  resume(id: string): TalkSession {
    const session = this.require(id);
    if (session.state === "live") {
      throw new TalkSessionError(409, "This talk session is already live — park it before resuming.");
    }
    session.state = "live";
    session.lastSeenAt = this.now();
    return session;
  }

  /** Remember the credential just handed out, so the next one can be required to
   *  outlive it. */
  recordToken(id: string, expiresAt: number): void {
    this.require(id).tokenExpiresAt = expiresAt;
  }

  heartbeat(id: string): TalkSession {
    const session = this.require(id);
    session.lastSeenAt = this.now();
    return session;
  }

  /** Append one completed exchange and re-apply the rolling truncation. */
  appendTurn(id: string, text: string, budgetTokens = TALK_CONTEXT_BUDGET_TOKENS): TalkTurnResult {
    const session = this.require(id);
    const turn: TalkTurnRecord = { at: this.now(), text, estimatedTokens: estimateTokens(text) };
    const truncated = truncateTurns([...session.turns, turn], budgetTokens);
    session.turns = truncated.turns;
    session.truncatedTurns += truncated.dropped;
    session.lastSeenAt = turn.at;
    return {
      contextTokens: contextTokens(session.turns),
      truncatedTurns: session.truncatedTurns,
      handoffSuggested: handoffSuggested(turn),
    };
  }

  /** The tools these intents add on top of what the session already carries. */
  exposeTools(id: string, intents: readonly string[]): RealtimeTool[] {
    const session = this.require(id);
    const added = toolsForIntents(intents, session.exposedTools);
    session.exposedTools.push(...added.map((tool) => tool.name));
    for (const intent of intents) {
      if (!session.expandedIntents.includes(intent)) session.expandedIntents.push(intent);
    }
    return added;
  }

  /** Idempotent: closing a session that is already gone is not an error. */
  close(id: string): void {
    this.sessions.delete(id);
  }

  /** Close every session whose last heartbeat predates the TTL. Returns the ids
   *  closed so the caller can log what it collected. */
  reap(): string[] {
    const cutoff = this.now() - TALK_SESSION_TTL_MS;
    const expired = [...this.sessions.values()]
      .filter((session) => session.lastSeenAt < cutoff)
      .map((session) => session.id);
    for (const id of expired) this.sessions.delete(id);
    return expired;
  }

  private require(id: string): TalkSession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new TalkSessionError(404, `Talk session ${id} does not exist — it was closed or never opened.`);
    }
    return session;
  }
}
