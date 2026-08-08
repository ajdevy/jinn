import type { IncomingMessage, ServerResponse } from "node:http";
import { UNIDENTIFIED_TOOL_CALL_ERROR } from "../mcp/identity.js";
import { readJsonBody } from "./http-helpers.js";
import type { CallerIdentity } from "./session-comm-guards.js";
import { armHeartbeat, HeartbeatLimitError, listHeartbeatsForSession, stopHeartbeat } from "../heartbeats/store.js";

export interface HeartbeatApiOptions {
  /** The gateway's verified view of who is calling. */
  resolveCaller: () => CallerIdentity;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * A heartbeat is always owned by the session that armed it, so an owner has to
 * exist before anything else happens. The operator has no session to own one and
 * is refused here alongside a tool call that lost its identity — absence of a
 * session identity is never authority to act as one.
 */
function ownerSessionId(res: ServerResponse, options: HeartbeatApiOptions): string | undefined {
  const identity = options.resolveCaller();
  if (identity.kind !== "session") {
    send(res, 403, { error: UNIDENTIFIED_TOOL_CALL_ERROR });
    return undefined;
  }
  return identity.callerId;
}

async function arm(req: IncomingMessage, res: ServerResponse, owner: string): Promise<void> {
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return;
  const body = (parsed.body ?? {}) as Record<string, unknown>;
  try {
    send(res, 201, armHeartbeat({
      ownerSessionId: owner,
      message: body.message as string,
      everySeconds: body.everySeconds as number,
      maxFires: body.maxFires as number | undefined,
      expiresAt: body.expiresAt as number | undefined,
    }));
  } catch (error) {
    if (!(error instanceof HeartbeatLimitError)) throw error;
    send(res, 422, { error: error.message });
  }
}

function stop(res: ServerResponse, owner: string, id: string): void {
  // 404 rather than 403 for someone else's heartbeat: a caller must not be able
  // to tell "not yours" from "does not exist".
  if (!stopHeartbeat(id, owner)) {
    send(res, 404, { error: `No armed heartbeat ${id} belongs to this session.` });
    return;
  }
  send(res, 200, { status: "stopped", id });
}

type HeartbeatRoute = { action: "list" } | { action: "arm" } | { action: "stop"; id: string };

/** Null for anything that is not one of this domain's three routes, so the
 *  request falls through to the rest of the API untouched. */
function routeFor(req: IncomingMessage): HeartbeatRoute | null {
  const parts = new URL(req.url ?? "/", "http://localhost").pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "heartbeats") return null;
  switch (`${req.method ?? "GET"} /${parts.length}`) {
    case "GET /2": return { action: "list" };
    case "POST /2": return { action: "arm" };
    case "DELETE /3": return { action: "stop", id: parts[2]! };
    default: return null;
  }
}

export async function handleHeartbeatApi(
  req: IncomingMessage,
  res: ServerResponse,
  options: HeartbeatApiOptions,
): Promise<boolean> {
  const route = routeFor(req);
  if (!route) return false;
  const owner = ownerSessionId(res, options);
  if (!owner) return true;
  if (route.action === "list") send(res, 200, { heartbeats: listHeartbeatsForSession(owner) });
  else if (route.action === "arm") await arm(req, res, owner);
  else stop(res, owner, route.id);
  return true;
}
