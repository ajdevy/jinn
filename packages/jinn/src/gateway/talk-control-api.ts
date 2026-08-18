import type { IncomingMessage, ServerResponse } from "node:http";
import type { TalkControlRuntime } from "../talk/control/runtime.js";
import { operationByName } from "../talk/control/manifest.js";
import type { TalkControlManifest } from "../talk/control/types.js";
import type { TalkSessionRegistry } from "../talk/session/registry.js";
import { readJsonBody } from "./http-helpers.js";
import type { CallerIdentity } from "./session-comm-guards.js";

interface ControlBody {
  providerCallId: string;
  providerItemId?: string;
  tool: string;
  arguments: string;
}

interface TalkControlApiOptions {
  caller: CallerIdentity;
  manifest: TalkControlManifest;
  registry: TalkSessionRegistry;
  runtime: TalkControlRuntime | undefined;
  send: (res: ServerResponse, status: number, body: unknown) => void;
}

async function readControlBody(
  req: IncomingMessage,
  res: ServerResponse,
  send: TalkControlApiOptions["send"],
): Promise<ControlBody | null> {
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return null;
  const body = (parsed.body ?? {}) as Record<string, unknown>;
  if (typeof body.providerCallId !== "string" || typeof body.tool !== "string" || typeof body.arguments !== "string") {
    send(res, 400, { error: "providerCallId, tool, and arguments are required strings." });
    return null;
  }
  if (body.providerItemId !== undefined && typeof body.providerItemId !== "string") {
    send(res, 400, { error: "providerItemId must be a string when present." });
    return null;
  }
  return {
    providerCallId: body.providerCallId,
    ...(body.providerItemId ? { providerItemId: body.providerItemId } : {}),
    tool: body.tool,
    arguments: body.arguments,
  };
}

function auditVerifiedControl(
  id: string,
  body: ControlBody,
  result: Awaited<ReturnType<TalkControlRuntime["dispatch"]>>,
  options: TalkControlApiOptions,
): void {
  const operation = operationByName(options.manifest, body.tool);
  if (!result.ok || result.replayed || operation?.mutability !== "write") return;
  const args = JSON.parse(body.arguments) as Record<string, unknown>;
  options.registry.recordAction(id, {
    tool: operation.name,
    subject: typeof args.id === "string" ? args.id : null,
    lane: "fast",
    consent: "not-required",
  });
}

export async function handleTalkControl(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  options: TalkControlApiOptions,
): Promise<void> {
  options.registry.heartbeat(id);
  if (!options.runtime) {
    options.send(res, 404, { error: `Talk session ${id} does not have an active control runtime.` });
    return;
  }
  const body = await readControlBody(req, res, options.send);
  if (!body) return;
  const result = await options.runtime.dispatch({ talkSessionId: id, ...body, caller: options.caller });
  auditVerifiedControl(id, body, result, options);
  options.send(res, 200, result);
}
