import type { IncomingMessage } from "node:http";
import { CALLER_SESSION_HEADER, verifySessionCapability } from "../mcp/identity.js";
import { getSession, isPortalAgentSession } from "../sessions/registry.js";
import { resolveCallerIdentity } from "./session-comm-guards.js";
import type { WorkflowDeciderAuthority } from "../workflows/approval-gate.js";

/** How the gateway records a decider that is a session rather than the operator. */
const SESSION_ACTOR_PREFIX = "session:";

/**
 * What a decider is allowed to be, looked up rather than taken from the request.
 *
 * Two callers may decide a gate the definition reserved: the operator surface,
 * and the portal session — the operator's own COO lane, whose shape (no
 * employee, no parent, no workflow provenance) is one no employee can mint,
 * because every spawn and delegation route records its caller as the child's
 * parent. Everything else is an employee, including the employee-less child a
 * session CAN spawn, and including a `session:` actor whose session has since
 * gone.
 */
export function deciderAuthority(decidedBy: string): WorkflowDeciderAuthority {
  if (decidedBy === "operator") return "operator";
  if (!decidedBy.startsWith(SESSION_ACTOR_PREFIX)) return "employee";
  const session = getSession(decidedBy.slice(SESSION_ACTOR_PREFIX.length));
  return session && isPortalAgentSession(session) ? "coo" : "employee";
}

/** Who to credit for a decision made over the Workflow HTTP route. */
export function approvalActor(req: IncomingMessage): string {
  const caller = req.headers[CALLER_SESSION_HEADER];
  if (typeof caller !== "string" || !caller) return "operator";
  return getSession(caller)?.employee ?? `session:${caller}`;
}

/** What that caller may decide, as opposed to who {@link approvalActor} credits.
 *  A gate reserved for the COO is authorized against this and never against the
 *  actor string: that string is read from a header the route does not verify, so
 *  a caller who merely names the portal session comes back an employee. */
export function approvalAuthority(req: IncomingMessage, authenticated: boolean): WorkflowDeciderAuthority {
  const identity = resolveCallerIdentity(req.headers, {
    sessionExists: (sessionId) => !!getSession(sessionId),
    verifySessionCapability,
    requireCapability: true,
    operatorAuthenticated: authenticated,
  });
  if (identity.kind === "operator") return "operator";
  if (identity.kind !== "session") return "employee";
  return deciderAuthority(`${SESSION_ACTOR_PREFIX}${identity.callerId}`);
}
