/**
 * `/api/talk/*` — the gateway half of the voice orb.
 *
 * The gateway mints a short-lived provider credential and does the accounting;
 * the browser opens its own connection to the provider and carries the audio.
 * Nothing here touches a media stream. Modelled on workflow-api.ts: one exported
 * handler the main dispatcher tries before its own routes.
 *
 * docs/talk-session-runtime.md is the contract this file implements.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { logger } from "../shared/logger.js";
import type { JinnConfig, Session } from "../shared/types.js";
import type { RealtimeTool } from "../shared/voice.js";
import { createSession, getSessionSpend } from "../sessions/registry.js";
import { scanOrg } from "./org.js";
import { UnknownRealtimeProviderError, createRealtimeProvider } from "../talk/realtime/index.js";
import { buildStandingBrief } from "../talk/session/brief.js";
import { TALK_CONTEXT_BUDGET_TOKENS, contextTokens, estimateTokens } from "../talk/session/context.js";
import { UNPINNED_MODEL, isPricingKnown } from "../talk/session/pricing.js";
import { TALK_SESSION_TTL_MS, TalkSessionError, TalkSessionRegistry } from "../talk/session/registry.js";
import { alwaysOnTools, estimateToolTokens, toolsByName } from "../talk/session/tools.js";
import type { TalkSession } from "../talk/session/types.js";
import { json, type ParsedRoute } from "./route-helpers.js";
import { handleTalkConfigApi } from "./talk-config-api.js";
import { handleTalkTtsApi } from "./talk-tts-api.js";
import { expandTools, handOff, recordAction, recordTurn } from "./talk-turn-api.js";

export interface TalkApiOptions {
  getConfig: () => JinnConfig;
  authenticated: boolean;
  /** Start the engine run for a handoff session. The dispatcher owns the engine
   *  wiring, so it passes this in rather than being imported from here. */
  runHandoff?: (session: Session, prompt: string) => void;
}

const talkSessions = new TalkSessionRegistry();
const REAP_INTERVAL_MS = 30_000;

// Unref'd: an idle reaper must never be the reason the process stays alive. It
// is the only thing that closes a session whose tab went away without a DELETE.
setInterval(() => {
  for (const id of talkSessions.reap()) {
    logger.info(`Talk session ${id} closed: no heartbeat for ${TALK_SESSION_TTL_MS}ms`);
  }
}, REAP_INTERVAL_MS).unref();

// Only the argument order is local: talk's failures carry their own messages, so
// none of the fixed-body helpers next to `json` fits.
const send = (res: ServerResponse, status: number, body: unknown): void => json(res, body, status);

function fail(res: ServerResponse, error: unknown): void {
  if (error instanceof TalkSessionError) {
    send(res, error.status, { error: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  logger.warn(`Talk API failed: ${message}`);
  send(res, 500, { error: "The talk session runtime failed to handle this request." });
}

/**
 * Build the provider, or answer 503 for the config the operator is missing.
 *
 * A provider that cannot be constructed is a configuration gap, so it is
 * reported as an unavailable feature rather than as a crash. `reason` is what
 * the client acts on: it turns the refusal into a setup prompt rather than into
 * a message. The factory's own words stay in `detail`, which is for the log and
 * for a test — the surface has a card for this and does not need the exception.
 */
function provider(config: JinnConfig, res: ServerResponse) {
  try {
    return createRealtimeProvider(config.realtime ?? {});
  } catch (error) {
    const detail = error instanceof UnknownRealtimeProviderError || error instanceof Error
      ? error.message
      : "realtime is not configured";
    send(res, 503, { error: "Voice is not available.", reason: "unconfigured", detail });
    return null;
  }
}

/** The model the session is billed as. Unset means the provider picks, and a
 *  model the gateway cannot name is a model it cannot price. */
function pinnedModel(config: JinnConfig): string {
  return config.realtime?.model?.trim() || UNPINNED_MODEL;
}

/** Mint a credential scoped to exactly `tools`. Answers 503 for a config gap and
 *  502 when the provider itself refuses, so the client can tell them apart. */
async function mint(res: ServerResponse, config: JinnConfig, tools: RealtimeTool[]) {
  const realtime = provider(config, res);
  if (!realtime) return null;
  try {
    return await realtime.mintEphemeralToken({ tools });
  } catch (error) {
    logger.warn(`Realtime token mint failed: ${error instanceof Error ? error.message : String(error)}`);
    send(res, 502, { error: "The realtime provider refused to issue a session credential." });
    return null;
  }
}

/** The session as the client sees it. Carries no credential: a token is only
 *  ever returned by the call that minted it. */
function statusOf(session: TalkSession) {
  return {
    id: session.id,
    sessionId: session.sessionId,
    state: session.state,
    model: session.model,
    openedAt: session.openedAt,
    lastSeenAt: session.lastSeenAt,
    turns: session.turns,
    truncatedTurns: session.truncatedTurns,
    actions: session.actions,
    brief: session.brief,
    // Reported alongside the turn budget, and deliberately not inside it: the
    // brief rides `instructions`, which the provider replaces rather than
    // accumulates, so it is not what truncation is defending against.
    briefChars: session.brief.length,
    briefTokens: estimateTokens(session.brief),
    contextTokens: contextTokens(session.turns),
    contextBudgetTokens: TALK_CONTEXT_BUDGET_TOKENS,
    exposedTools: session.exposedTools,
    toolTokens: estimateToolTokens(toolsByName(session.exposedTools)),
    spendUsd: getSessionSpend([session.sessionId]),
    pricingKnown: isPricingKnown(session.model),
  };
}

/** The collection itself: POST opens a session, and nothing else lives here. */
async function openRoute(res: ServerResponse, config: JinnConfig, method: string): Promise<boolean> {
  if (method !== "POST") return false;
  const tools = alwaysOnTools();
  const token = await mint(res, config, tools);
  if (!token) return true; // mint already answered with 503 or 502
  // The row exists so spend reuses the session ledger. `talk` is already a
  // non-connector source, so nothing tries to reply into it.
  const row = createSession({
    engine: config.realtime?.provider ?? "realtime",
    source: "talk",
    sourceRef: `talk:${randomUUID()}`,
    connector: "talk",
  });
  const session = talkSessions.open({
    sessionId: row.id,
    model: pinnedModel(config),
    brief: buildStandingBrief(config, scanOrg(config)).text,
    tokenExpiresAt: token.expiresAt,
  });
  send(res, 201, { ...statusOf(session), token: token.value, expiresAt: token.expiresAt, tools });
  return true;
}

/**
 * Mint a credential that outlives the one the session already holds.
 *
 * Provider expiries are whole seconds anchored at the moment of minting, so two
 * mints inside one second expire together and a resumed client cannot tell its
 * new credential from the one it replaced. Waiting out the second is what makes
 * the successor genuinely longer-lived; a provider that still will not extend
 * has handed back a credential that dies with its predecessor, which is a
 * provider fault rather than something to pass on to the client.
 */
async function mintSuccessor(res: ServerResponse, config: JinnConfig, session: TalkSession, tools: RealtimeTool[]) {
  const token = await mint(res, config, tools);
  if (!token || token.expiresAt > session.tokenExpiresAt) return token;
  await delay(1000 - (Date.now() % 1000));
  const retried = await mint(res, config, tools);
  if (!retried || retried.expiresAt > session.tokenExpiresAt) return retried;
  send(res, 502, {
    error: "The realtime provider reissued a session credential that expires no later than the one it replaced.",
  });
  return null;
}

/** Re-mint for an expiring credential or a resume, scoped to whatever the
 *  session has been granted so far rather than to the always-on set. */
async function reissueToken(res: ServerResponse, config: JinnConfig, session: TalkSession): Promise<void> {
  const tools = toolsByName(session.exposedTools);
  const token = await mintSuccessor(res, config, session, tools);
  if (!token) return;
  talkSessions.recordToken(session.id, token.expiresAt);
  send(res, 200, { ...statusOf(session), token: token.value, expiresAt: token.expiresAt, tools });
}

/** `/api/talk/sessions/:id` itself: read it or close it. */
function sessionResource(res: ServerResponse, id: string, method: string): boolean {
  if (method === "DELETE") {
    talkSessions.close(id);
    send(res, 200, { id, state: "closed" });
    return true;
  }
  if (method !== "GET") return false;
  const session = talkSessions.get(id);
  if (!session) {
    send(res, 404, { error: `Talk session ${id} does not exist: it was closed or never opened.` });
    return true;
  }
  send(res, 200, statusOf(session));
  return true;
}

/** `/api/talk/sessions/:id/<action>`. Every branch resolves the session through
 *  the registry, which raises a typed 404 of its own when the id is unknown. */
async function sessionAction(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  action: string,
  options: TalkApiOptions,
): Promise<boolean> {
  switch (action) {
    case "park":
      send(res, 200, statusOf(talkSessions.park(id)));
      return true;
    case "resume":
      await reissueToken(res, options.getConfig(), talkSessions.resume(id));
      return true;
    case "token":
      await reissueToken(res, options.getConfig(), talkSessions.heartbeat(id));
      return true;
    case "heartbeat":
      send(res, 200, statusOf(talkSessions.heartbeat(id)));
      return true;
    case "tools":
      await expandTools(req, res, talkSessions.heartbeat(id), talkSessions);
      return true;
    case "turn":
      await recordTurn(req, res, talkSessions.heartbeat(id), talkSessions);
      return true;
    case "actions":
      await recordAction(req, res, talkSessions.heartbeat(id), talkSessions);
      return true;
    case "handoff":
      await handOff(req, res, talkSessions.heartbeat(id), options.getConfig(), options.runHandoff);
      return true;
    default:
      return false;
  }
}

/** The path segments of a `/api/talk/sessions[/:id[/action]]` request, or null
 *  for anything this router does not own. */
function talkSessionsPath(pathname: string): string[] | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "talk" || parts[2] !== "sessions") return null;
  if (parts.length < 3 || parts.length > 5) return null;
  return parts;
}

/** Writes need the operator. Reads stay open, like the rest of the read surface. */
function unauthorizedWrite(res: ServerResponse, method: string, options: TalkApiOptions): boolean {
  if (method === "GET" || options.authenticated) return false;
  send(res, 401, { error: "Talk session authentication required." });
  return true;
}

/** The talk routes that are not sessions: read-aloud, and the voice-setup probe.
 *  Tried before the session router for the same reason this module is tried
 *  before the main dispatcher — whoever owns the path answers it. */
async function nonSessionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  config: JinnConfig,
): Promise<boolean> {
  if (await handleTalkTtsApi(req, res, pathname, config)) return true;
  return handleTalkConfigApi(req, res, pathname, config);
}

export async function handleTalkApi(
  req: IncomingMessage,
  res: ServerResponse,
  route: ParsedRoute,
  options: TalkApiOptions,
): Promise<boolean> {
  const { pathname, method } = route;
  const config = options.getConfig();
  if (await nonSessionRoutes(req, res, pathname, config)) return true;

  const parts = talkSessionsPath(pathname);
  if (!parts) return false;
  if (unauthorizedWrite(res, method, options)) return true;

  try {
    if (parts.length === 3) return await openRoute(res, config, method);
    if (parts.length === 4) return sessionResource(res, parts[3]!, method);
    if (method !== "POST") return false;
    return await sessionAction(req, res, parts[3]!, parts[4]!, options);
  } catch (error) {
    fail(res, error);
    return true;
  }
}
