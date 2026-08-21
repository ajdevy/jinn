import { getSession, updateSession } from "../registry.js";
import type { JsonObject, Session } from "../../shared/types.js";

/**
 * Marker a request handler writes when a new user message arrives while a turn
 * is still running: the old turn's answer is no longer wanted, so it settles
 * quietly as interrupted instead of replying over the newer one.
 */
export const SUPERSEDED_TURN_META_KEY = "supersededRunningTurnAt";

function withTransportMeta(session: Session, updates: JsonObject): JsonObject {
  const base =
    session.transportMeta && typeof session.transportMeta === "object" && !Array.isArray(session.transportMeta)
      ? session.transportMeta
      : {};
  return { ...base, ...updates };
}

/** Write the marker: a newer user intent has displaced this session's live turn. */
export function supersedeRunningTurn(session: Session): void {
  updateSession(session.id, {
    transportMeta: withTransportMeta(session, {
      [SUPERSEDED_TURN_META_KEY]: new Date().toISOString(),
    }),
    ...(session.workflowProvenance?.kind === "phase" ? {
      attemptInterruptionCause: "user-message",
      attemptInterruptionTurn: (session.attemptTurn ?? 0) + 1,
    } : {}),
  });
}

export function clearSupersededTurnMeta(sessionId: string): void {
  const session = getSession(sessionId);
  const meta = session?.transportMeta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta) || !(SUPERSEDED_TURN_META_KEY in meta)) return;
  const next = { ...meta };
  delete next[SUPERSEDED_TURN_META_KEY];
  updateSession(sessionId, { transportMeta: next });
}

export function isTurnSuperseded(sessionId: string, turnStartedAt: number): boolean {
  const marker = getSession(sessionId)?.transportMeta?.[SUPERSEDED_TURN_META_KEY];
  if (typeof marker !== "string") return false;
  const markedAt = new Date(marker).getTime();
  return Number.isFinite(markedAt) && markedAt >= turnStartedAt;
}
