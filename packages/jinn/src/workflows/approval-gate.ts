import type { ApprovalNode } from "./model.js";

/** What a decider is, as the gateway looked it up rather than as the request
 *  claimed. `decidedBy` records who to credit; this records what they may
 *  decide, and a caller that never meets a reserved gate omits it. */
export type WorkflowDeciderAuthority = "operator" | "coo" | "employee";

/**
 * Why this decider may not decide this gate, in the words the surface reports,
 * or undefined when they may.
 *
 * The three reservations are checked in the order they narrow: a gate kept for
 * the human operator, a gate handed to the COO's own lane, and a gate routed to
 * a named approver. Only the first is decided on the actor string; the COO class
 * is decided on the authority, because the actor string is taken from a header
 * the decide route does not verify, and a class anyone could claim by naming the
 * portal session would be no reservation at all.
 */
export function gateRefusal(nodeId: string, config: ApprovalNode["config"], decidedBy: string,
  authority: WorkflowDeciderAuthority | undefined, approverRef: string | undefined): string | undefined {
  if (config.operatorOnly && decidedBy !== "operator") {
    return `Workflow approval ${nodeId} is operator-only; ${decidedBy} cannot decide it.`;
  }
  if (config.decidableBy === "coo" && authority !== "operator" && authority !== "coo") {
    return `Workflow approval ${nodeId} is COO-decidable; ${decidedBy} cannot decide it.`;
  }
  if (approverRef && decidedBy !== approverRef && decidedBy !== "operator") {
    return `Workflow actor ${decidedBy} is not authorized for approval ${nodeId}.`;
  }
  return undefined;
}
