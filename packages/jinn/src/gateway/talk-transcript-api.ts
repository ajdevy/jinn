import type { IncomingMessage, ServerResponse } from "node:http";
import { initDb } from "../shared/db.js";
import { TalkApprovalRepository } from "../talk/approval/repository.js";
import type { TalkSession } from "../talk/session/types.js";
import { readJsonBody } from "./http-helpers.js";

interface Options {
  send: (res: ServerResponse, status: number, body: unknown) => void;
}

const bounded = (value: unknown, max = 200): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

function validEvidence(body: Record<string, unknown>): boolean {
  const boundedFields = [body.browserInstanceId, body.providerItemId, body.providerEventId];
  return boundedFields.every((value) => bounded(value))
    && Number.isInteger(body.credentialGeneration) && bounded(body.transcript, 4000);
}

function matchesSession(body: Record<string, unknown>, session: TalkSession): boolean {
  return body.browserInstanceId === session.browserInstanceId && body.credentialGeneration === session.credentialGeneration;
}

export async function handleTalkTranscript(
  req: IncomingMessage,
  res: ServerResponse,
  session: TalkSession,
  options: Options,
): Promise<void> {
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return;
  const body = (parsed.body ?? {}) as Record<string, unknown>;
  if (!validEvidence(body)) {
    options.send(res, 400, { error: "Bounded browser, generation, provider item/event, and transcript evidence are required." });
    return;
  }
  if (!matchesSession(body, session)) {
    options.send(res, 409, { error: "Transcript evidence does not match the active browser credential generation." });
    return;
  }
  try {
    const evidence = new TalkApprovalRepository(initDb()).recordTranscript({
      talkSessionId: session.id,
      browserInstanceId: session.browserInstanceId,
      credentialGeneration: session.credentialGeneration,
      providerItemId: String(body.providerItemId),
      providerEventId: String(body.providerEventId),
      transcript: String(body.transcript),
      recordedAt: Date.now(),
    });
    options.send(res, 200, { ok: true, inputOrdinal: evidence.inputOrdinal });
  } catch (error) {
    options.send(res, 409, { error: error instanceof Error ? error.message : "Transcript evidence conflicted." });
  }
}
