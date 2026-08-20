import { initDb } from '../shared/db.js';
import { currentApproval } from './approval-rows.js';
import { appendWorkItemEvent, getWorkItem, type WorkItem } from './store.js';
import type { ApprovalDecision } from './approvals.js';

/**
 * The raw write on an approval ROW: state, stamps, picked option, and the one
 * `approval_decided` event — nothing about the Todo's status, and nothing that
 * notifies. Its own module beside `approval-rows.ts` (the raw read) because two
 * callers need exactly this and no more: `approvals.ts` composes it into the
 * native consequence rules, and the Workflow surface settles a gate its run
 * already decided. Routing a settle through the notifying door instead would
 * wake the mirror-back listener and re-decide the gate it came from.
 */

export class ApprovalChoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalChoiceError';
  }
}

/** Thrown when a decision lands on an item whose approval is no longer `pending`
 *  (a double-decide, or a decide-after-resolve race) — surfaced as `no-pending`.
 *  It is the in-transaction guard that makes the native decision atomic: raised
 *  inside the decision transaction, it rolls the whole thing back. */
export class ApprovalNotPendingError extends Error {
  constructor(id: string) {
    super(`work item ${id} has no pending approval to decide`);
    this.name = 'ApprovalNotPendingError';
  }
}

/**
 * Record a human decision on an item's pending approval (raw write): set the
 * `approved`/`rejected` state + the decided-by/at stamps and append ONE
 * `approval_decided` event. Status is NOT touched here — `decideWorkItemApproval`
 * applies the fixed consequence rules. Throws on an unknown item.
 */
export function decideApproval(id: string, decision: ApprovalDecision, decidedBy: string, note?: string, choice?: string): WorkItem {
  const db = initDb();
  const txn = db.transaction((): WorkItem => {
    const item = getWorkItem(id);
    if (!item) throw new Error(`decideApproval: work item ${id} not found`);
    const current = currentApproval(item.id);
    if (current?.state !== 'pending') throw new ApprovalNotPendingError(id);
    const picked = resolveChoice(current, decision, choice);
    const state = decision === 'approve' ? 'approved' : 'rejected';
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE work_item_approvals
         SET state = ?, decided_by = ?, decided_at = ?, note = ?
       WHERE id = ? AND state = 'pending'`,
    ).run(state, decidedBy, now, note ?? null, current.id);
    if (picked !== undefined) {
      db.prepare('UPDATE work_item_approval_choices SET choice = ? WHERE approval_id = ?').run(picked, current.id);
    }
    db.prepare('UPDATE work_items SET updated_at = ?, version = version + 1 WHERE id = ?').run(now, item.id);
    appendWorkItemEvent({
      workItemId: id,
      kind: 'approval_decided',
      actor: decidedBy,
      detail: {
        decision,
        ...(picked !== undefined ? { choice: picked } : {}),
        ...(note !== undefined ? { note } : {}),
        ...(current.ref ? { ref: current.ref } : {}),
      },
    });
    return getWorkItem(id)!;
  });
  return txn();
}

/**
 * The choice rules, applied to the pending gate being decided. Approving a gate
 * that offers options REQUIRES picking one of them — never a silent default —
 * and a choice is meaningless on a gate that offers none, or on a rejection.
 * Returns the option to persist, or undefined when there is nothing to persist.
 */
function resolveChoice(
  current: { options: string[] | null },
  decision: ApprovalDecision,
  choice: string | undefined,
): string | undefined {
  if (choice !== undefined) {
    if (decision !== 'approve') throw new ApprovalChoiceError('a choice can only accompany an approve decision');
    if (!current.options) throw new ApprovalChoiceError('this approval does not offer options to choose from');
    if (!current.options.includes(choice)) {
      throw new ApprovalChoiceError(`choice must be one of the offered options: ${current.options.join(', ')}`);
    }
    return choice;
  }
  if (current.options && decision === 'approve') {
    throw new ApprovalChoiceError(`approving this Todo requires choosing one of: ${current.options.join(', ')}`);
  }
  return undefined;
}
