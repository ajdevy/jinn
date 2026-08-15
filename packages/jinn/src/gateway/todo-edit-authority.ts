/**
 * Who may edit which field of a Todo through the metadata pen, and what a
 * refusal tells them.
 *
 * This lived inside the route file until `verifyPolicy` stopped being a single
 * yes-or-no: one key inside it now answers to a different caller from the rest,
 * which is a rule with enough of its own shape to be read, and tested, on its
 * own.
 */

import { effectiveVerifyMode, type UpdateWorkItemInput, type WorkItem } from '../work-items/store.js';
import { declaresOnlyDeliverable } from '../work-items/verify-policy.js';
import { workItemActor, type WorkItemCaller } from './work-item-arming.js';

/** What a Todo SAYS: open to every authenticated session, like its status. */
const TODO_CONTENT_FIELDS: ReadonlyArray<keyof UpdateWorkItemInput> = ['title', 'body', 'acceptance', 'priority', 'dueAt'];

/** Who a Todo BELONGS to: the operator's alone. */
const TODO_OWNERSHIP_FIELDS: ReadonlyArray<keyof UpdateWorkItemInput> = ['assignee', 'department', 'rank'];

/** How a Todo is reviewed. The operator's too, apart from the one key inside it
 *  that says only where the product lands — see resolveTodoEditAuthority. */
const TODO_REVIEW_FIELD: keyof UpdateWorkItemInput = 'verifyPolicy';

export interface TodoEditAuthority {
  fields: ReadonlySet<keyof UpdateWorkItemInput>;
  actor: string;
  who: string;
}

/**
 * Resolve the per-field edit authority, split on content versus ownership.
 *
 * Content is open for the same reason status is: gating it on a relation to the
 * Todo (creator / assignee / assignee's manager / bound workflow run) bought
 * nothing and cost honesty. A participant that could do the work could not
 * record what the work now says, and had to ask someone with standing to
 * perform the write for it. Every new kind of participant needed its own
 * relation and its own 403 before it could describe its own Todo.
 *
 * Ownership stays operator-only, and deliberately: assignee, department, and
 * rank decide who is accountable. Those are governance, not description, and an
 * agent reassigning its own work is exactly what the review model exists to
 * prevent. `verifyPolicy` is governance for the same reason — it decides who
 * reviews the work — with one exception that is not: `deliverable` says only
 * where the product lands, and a Todo delivering into the operator's workspace
 * has to be able to say so from the lane doing the delivering, because every
 * bound MCP call arrives as a session and an operator-only route would mean no
 * lane could ever declare its own. So the Todo's own assignee or creator may
 * set that key, and only when the rest of the submitted policy matches what is
 * stored, so a declaration can never carry a review mode in with it.
 *
 * The declaration is a hint, not a verdict: what the pipeline does with a
 * `workspace` route it validates against the real diff, which is why letting an
 * agent declare one buys it no way around review.
 */
export function resolveTodoEditAuthority(
  caller: WorkItemCaller,
  item: WorkItem,
  patch: UpdateWorkItemInput,
): TodoEditAuthority {
  if (caller.kind === 'operator') {
    return {
      fields: new Set<keyof UpdateWorkItemInput>([...TODO_CONTENT_FIELDS, ...TODO_OWNERSHIP_FIELDS, TODO_REVIEW_FIELD]),
      actor: 'operator',
      who: 'the operator',
    };
  }
  const employee = caller.session.employee;
  const fields = new Set<keyof UpdateWorkItemInput>(TODO_CONTENT_FIELDS);
  // Same reading of "the Todo's own" the dispatch-config and labels routes use:
  // a session with no employee is recorded as `session:<id>` when it creates a
  // Todo, so keying only on the employee name shut the creator lane out of
  // exactly the sessions that have no other name to be known by.
  const ownsTodo = item.createdBy === workItemActor(caller)
    || (employee !== undefined && (employee === item.assignee || employee === item.createdBy));
  if (
    ownsTodo
    && patch.verifyPolicy !== undefined
    && declaresOnlyDeliverable(item.verifyPolicy, patch.verifyPolicy, effectiveVerifyMode(item))
  ) {
    fields.add(TODO_REVIEW_FIELD);
  }
  return {
    fields,
    actor: employee ?? workItemActor(caller),
    who: employee ? `employee "${employee}"` : `session ${caller.callerId}`,
  };
}

/** Why a field was refused, naming what this caller may set instead. A flat
 *  "operator-only" would send a Todo's own assignee away from a door that is
 *  open to them, which is how the declaration went unusable in the first place. */
export function todoEditRefusal(field: keyof UpdateWorkItemInput, item: WorkItem, who: string): string {
  const scope = field === TODO_REVIEW_FIELD
    ? `only Todo ${item.id}'s assignee or creator may set ${TODO_REVIEW_FIELD}, and only its deliverable key — mode, verifier, and maxRounds are the operator's`
    : `${TODO_OWNERSHIP_FIELDS.join(', ')} are operator-only`;
  return `field "${field}" is not editable by ${who}: ${scope}`;
}
