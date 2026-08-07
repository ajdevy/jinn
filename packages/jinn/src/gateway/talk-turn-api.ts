/**
 * The `/api/talk/sessions/:id/*` operations that carry a request body: recording
 * a turn's usage, widening the exposed tool set, and handing a request off to a
 * normal text session.
 *
 * Split out of talk-api.ts, which keeps the routing, the credential minting, and
 * the lifecycle transitions. The registry is passed in rather than imported so
 * the two modules do not have to reference each other.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { JinnConfig, Session } from "../shared/types.js";
import type { RealtimeUsage } from "../shared/voice.js";
import { createSession, getSessionSpend, insertMessage, recordTurnAccounting } from "../sessions/registry.js";
import { priceTurn } from "../talk/session/pricing.js";
import type { TalkSessionRegistry } from "../talk/session/registry.js";
import { TALK_TOOL_INTENTS, estimateToolTokens, isKnownIntent, toolsByName } from "../talk/session/tools.js";
import type { TalkSession } from "../talk/session/types.js";
import { readJsonBody } from "./http-helpers.js";

type JsonRequest = Parameters<typeof readJsonBody>[0];

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Accept a usage payload only when every token count is a non-negative finite
 *  number, so a malformed client cannot quietly bill a session zero. */
function numericUsage(value: unknown): RealtimeUsage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const keys = [
    "inputAudioTokens",
    "outputAudioTokens",
    "inputTextTokens",
    "outputTextTokens",
    "cachedInputAudioTokens",
    "cachedInputTextTokens",
  ] as const;
  const usage = {} as RealtimeUsage;
  for (const key of keys) {
    const count = raw[key];
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return null;
    usage[key] = count;
  }
  return usage;
}

/**
 * `usage` is this turn's delta, not a session-to-date total: the provider's
 * `turn_done` event reports the running total, so the client subtracts before
 * posting. Spend goes through `recordTurnAccounting`, the single accounting
 * entry point, which is what puts a talk session in the cost report for free.
 */
export async function recordTurn(
  req: IncomingMessage,
  res: ServerResponse,
  session: TalkSession,
  registry: TalkSessionRegistry,
): Promise<void> {
  const parsed = await readJsonBody(req as JsonRequest, res);
  if (!parsed.ok) return;
  const body = (parsed.body ?? {}) as { usage?: unknown; transcript?: unknown };
  const usage = numericUsage(body.usage);
  if (!usage) {
    send(res, 400, { error: "usage must carry a non-negative number for every RealtimeUsage token count." });
    return;
  }
  if (body.transcript !== undefined && typeof body.transcript !== "string") {
    send(res, 400, { error: "transcript must be a string when present." });
    return;
  }
  const priced = priceTurn(session.model, usage);
  recordTurnAccounting(session.sessionId, { cost: priced.costUsd, numTurns: 1 });
  const turn = registry.appendTurn(session.id, body.transcript ?? "");
  send(res, 200, {
    ...turn,
    costUsd: priced.costUsd,
    pricingKnown: priced.pricingKnown,
    spendUsd: getSessionSpend([session.sessionId]),
  });
}

export async function expandTools(
  req: IncomingMessage,
  res: ServerResponse,
  session: TalkSession,
  registry: TalkSessionRegistry,
): Promise<void> {
  const parsed = await readJsonBody(req as JsonRequest, res);
  if (!parsed.ok) return;
  const intents = (parsed.body as { intents?: unknown } | null)?.intents;
  if (!Array.isArray(intents) || intents.some((intent) => typeof intent !== "string")) {
    send(res, 400, { error: "intents must be an array of strings." });
    return;
  }
  const unknown = (intents as string[]).filter((intent) => !isKnownIntent(intent));
  if (unknown.length > 0) {
    send(res, 400, {
      error: `Unknown tool intent(s): ${unknown.join(", ")}. Known intents: ${TALK_TOOL_INTENTS.join(", ")}.`,
    });
    return;
  }
  const added = registry.exposeTools(session.id, intents as string[]);
  send(res, 200, {
    tools: added,
    exposedTools: session.exposedTools,
    toolTokens: estimateToolTokens(toolsByName(session.exposedTools)),
  });
}

/** Spawn a normal text session with the talk session's row as its parent, so the
 *  existing callback machinery reaches it without anyone polling. */
export async function handOff(
  req: IncomingMessage,
  res: ServerResponse,
  session: TalkSession,
  config: JinnConfig,
  runHandoff?: (spawned: Session, prompt: string) => void,
): Promise<void> {
  const parsed = await readJsonBody(req as JsonRequest, res);
  if (!parsed.ok) return;
  const prompt = (parsed.body as { prompt?: unknown } | null)?.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    send(res, 400, { error: "prompt must be a non-empty string." });
    return;
  }
  const spawned = createSession({
    engine: config.engines.default,
    source: "web",
    sourceRef: `talk-handoff:${randomUUID()}`,
    connector: "web",
    replyContext: { source: "web" },
    parentSessionId: session.sessionId,
    prompt,
  });
  insertMessage(spawned.id, "user", prompt);
  runHandoff?.(spawned, prompt);
  send(res, 201, { sessionId: spawned.id, parentSessionId: session.sessionId });
}
