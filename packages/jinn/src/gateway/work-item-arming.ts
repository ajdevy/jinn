import { isPortalAgentSession } from "../sessions/registry.js";
import type { JinnConfig, Session } from "../shared/types.js";
import type { WriteOrigin } from "../work-items/origin.js";

/**
 * Who may reach a `todo-status` Workflow trigger filtered on the operator.
 *
 * Two roads lead there and they are deliberately different widths, so they are
 * read side by side rather than a page apart in the route file.
 */

export type WorkItemCaller = { origin?: WriteOrigin }
  & ({ kind: 'operator'; session?: undefined; callerId?: undefined } | { kind: 'session'; session: Session; callerId: string });

export function workItemActor(caller: WorkItemCaller): string {
  return caller.kind === 'session' ? `session:${caller.callerId}` : 'operator';
}

/**
 * `asOperator` stamps the transition's recorded actor as `operator`, so a
 * `todo-status` Workflow trigger filtered on the operator fires for work the
 * COO arms on the operator's behalf.
 *
 * That actor string is an authority boundary — filtering on it is what keeps an
 * arbitrary employee from starting a pipeline nobody asked for — so exactly two
 * callers may claim it: the authenticated operator surface, for which it is a
 * no-op, and the gateway's own top-level agent session, the COO the operator is
 * talking to.
 *
 * The COO is deliberately NOT an org employee — the portal is the root, and
 * `resolveRootApprovalTarget()` answers with a VIRTUAL root that matches no
 * session's employee. So the claim cannot be keyed on an employee name; it is
 * keyed on the session shape only the operator's own surfaces produce
 * (`isPortalAgentSession`). An employee session never has that shape, and
 * neither does anything an employee can spawn.
 *
 * The claim never erases the claimant: the audit event's `actor` reads
 * `operator` for the trigger, and its `detail.asOperator` names the session that
 * actually made the call.
 *
 * `resolveArmingDelegate()` below reaches the same trigger by a deliberately
 * narrower road: it rewrites no actor, applies only to `assigned`, and is
 * granted per employee by config rather than inferred from session shape. An
 * employee refused here can still be a delegate there, and that is the point —
 * arming a pipeline is a fraction of what claiming the operator buys.
 */
export function authorizeActingAsOperator(caller: WorkItemCaller): { ok: true; actingAs?: string } | { ok: false; error: string } {
  if (caller.kind === 'operator') return { ok: true };
  if (!isPortalAgentSession(caller.session)) {
    const who = caller.session.employee ? `employee "${caller.session.employee}"` : `session ${caller.callerId}`;
    return {
      ok: false,
      error: `asOperator records the transition as the operator and is reserved for the operator surface and the top-level COO session; ${who} must transition as itself`,
    };
  }
  return { ok: true, actingAs: workItemActor(caller) };
}

/**
 * The employee this transition is armed on behalf of, or undefined when nothing
 * is delegated. Only a session moving a Todo to `assigned` can produce one, and
 * only when `workflows.armingDelegates` names its employee.
 *
 * The name comes from the session's own identity, never from the request, so
 * the stamp is a fact the gateway asserts rather than a claim a caller makes.
 * The list is user-authored YAML, so entries that are not names are skipped
 * rather than trusted into a comparison.
 */
export function resolveArmingDelegate(caller: WorkItemCaller, target: string, config: JinnConfig): string | undefined {
  if (target !== "assigned" || caller.kind !== "session") return undefined;
  const employee = caller.session.employee;
  if (!employee) return undefined;
  const delegates = config.workflows?.armingDelegates;
  if (!Array.isArray(delegates)) return undefined;
  return delegates.some((name) => typeof name === "string" && name.trim() === employee) ? employee : undefined;
}
