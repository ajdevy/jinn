import type http from "node:http";
import { UNIDENTIFIED_TOOL_CALL_ERROR, verifySessionCapability } from "../mcp/identity.js";
import { getSession } from "../sessions/registry.js";
import { resolveCallerIdentity, type CallerIdentityOptions } from "./session-comm-guards.js";

/**
 * Who may open a WebSocket upgrade.
 *
 * The HTTP side of caller identity is enforced by the request handler; an
 * upgrade never reaches it, so these are the equivalent gate for a socket. Both
 * answer on the raw socket, because there is no ServerResponse to write to once
 * the connection is being upgraded.
 */

/** The little of a raw upgrade socket a rejection needs. */
export type UpgradeRejectionSocket = {
  write(chunk: string): unknown;
  destroy(): unknown;
};

function reject(socket: UpgradeRejectionSocket, error: string): true {
  socket.write(
    "HTTP/1.1 403 Forbidden\r\n" +
    "Connection: close\r\n" +
    "Content-Type: application/json\r\n" +
    "\r\n" +
    JSON.stringify({ error }),
  );
  socket.destroy();
  return true;
}

export function rejectUnverifiedIdentifiedUpgradeCaller(
  req: http.IncomingMessage,
  socket: UpgradeRejectionSocket,
  options: Pick<CallerIdentityOptions, "sessionExists"> = {},
): boolean {
  const identity = resolveCallerIdentity(req.headers, {
    sessionExists: options.sessionExists ?? ((sessionId) => !!getSession(sessionId)),
    verifySessionCapability,
    requireCapability: true,
  });
  if (identity.kind !== "unidentified-tool") return false;
  return reject(socket, UNIDENTIFIED_TOOL_CALL_ERROR);
}

export function rejectNonOperatorPtyUpgradeCaller(
  req: http.IncomingMessage,
  socket: UpgradeRejectionSocket,
  options: Pick<CallerIdentityOptions, "sessionExists" | "operatorAuthenticated"> = {},
): boolean {
  const identity = resolveCallerIdentity(req.headers, {
    sessionExists: options.sessionExists ?? ((sessionId) => !!getSession(sessionId)),
    verifySessionCapability,
    requireCapability: true,
    operatorAuthenticated: options.operatorAuthenticated,
  });
  if (identity.kind === "operator") return false;
  return reject(
    socket,
    identity.kind === "unidentified-tool"
      ? UNIDENTIFIED_TOOL_CALL_ERROR
      : "/ws/pty is operator-only; capability-bound sessions cannot attach to or inject stdin into PTY sessions",
  );
}
