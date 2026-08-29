import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";

import { handleMcpRequest, buildTools, notesEnabledFromConfig } from "../mcp/server.js";
import type { JinnMcpContext, JinnMcpTool } from "../mcp/toolkit.js";
import { verifyGatewayAuth } from "./auth.js";
import { readJsonBody } from "./http-helpers.js";
import { json } from "./route-helpers.js";
import { logger } from "../shared/logger.js";
import type { ApiContext } from "./api.js";

/**
 * JSON-RPC over HTTP for the `jinn` MCP server.
 *
 * The stdio entry (`mcp/server-entry.ts`) only serves a process the gateway
 * spawns itself, which leaves no way for a client on another machine — Claude
 * Desktop, an IDE — to reach the same tools. `handleMcpRequest` was already
 * transport-free, so this adds a second door to the identical dispatcher rather
 * than a second implementation of the protocol.
 *
 * Authentication is the gateway's own bearer token: this endpoint exposes the
 * same company surface the REST API already does, to the same credential, and
 * it is refused outright when the gateway has no token so a token-less instance
 * cannot be reached this way from the network.
 */

const MCP_BODY_MAX_BYTES = 1024 * 1024;

let cachedTools: JinnMcpTool[] | null = null;

/** Built once: the set is fixed at boot and rebuilding it per request would
 *  re-read config on a hot path. */
function tools(): JinnMcpTool[] {
  if (!cachedTools) cachedTools = buildTools({ notesEnabled: notesEnabledFromConfig() });
  return cachedTools;
}

/** Exposed for tests, which need a clean set after changing config. */
export function resetMcpHttpTools(): void {
  cachedTools = null;
}

/** Returns the status to answer with, or null when the caller may proceed. */
function rejection(req: HttpRequest, route: { method: string }, context: ApiContext): { status: number; error: string } | null {
  if (route.method !== "POST") return { status: 405, error: "method not allowed" };
  if (!context.gatewayAuthToken) return { status: 503, error: "mcp over http requires gateway authentication" };
  if (!verifyGatewayAuth(req.headers, context.gatewayAuthToken, context.jinnHome)) {
    return { status: 401, error: "unauthorized" };
  }
  return null;
}

function requestContext(context: ApiContext): JinnMcpContext {
  return {
    // Loopback: the tools call this same gateway, and going out through the
    // public hostname would leave the machine and come back through the proxy.
    gatewayUrl: `http://127.0.0.1:${context.runtimePort ?? context.getConfig().gateway.port}`,
    token: context.gatewayAuthToken,
  };
}

type Dispatched = { ok: true; responses: unknown[] } | { ok: false; status: number; error: string };

async function dispatch(batch: unknown[], ctx: JinnMcpContext): Promise<Dispatched> {
  if (batch.length === 0) return { ok: false, status: 400, error: "empty batch" };
  const responses: unknown[] = [];
  for (const message of batch) {
    if (!message || typeof message !== "object") {
      return { ok: false, status: 400, error: "malformed json-rpc message" };
    }
    try {
      const answer = await handleMcpRequest(message as never, tools(), ctx);
      // null is a notification: correct to answer nothing at all.
      if (answer) responses.push(answer);
    } catch (err) {
      logger.warn(`MCP over HTTP failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, status: 500, error: "mcp request failed" };
    }
  }
  return { ok: true, responses };
}

export async function handleMcpHttp(
  req: HttpRequest,
  res: ServerResponse,
  route: { method: string; pathname: string },
  context: ApiContext,
): Promise<boolean> {
  if (route.pathname !== "/api/mcp") return false;

  const refused = rejection(req, route, context);
  if (refused) {
    json(res, { error: refused.error }, refused.status);
    return true;
  }

  const parsed = await readJsonBody(req, res, { maxBytes: MCP_BODY_MAX_BYTES });
  if (!parsed.ok) return true;

  const body = parsed.body;
  const result = await dispatch(Array.isArray(body) ? body : [body], requestContext(context));
  if (!result.ok) {
    json(res, { error: result.error }, result.status);
    return true;
  }

  // Every message was a notification — 202 with no body, per JSON-RPC.
  if (result.responses.length === 0) {
    res.writeHead(202).end();
    return true;
  }

  json(res, Array.isArray(body) ? result.responses : result.responses[0], 200);
  return true;
}
