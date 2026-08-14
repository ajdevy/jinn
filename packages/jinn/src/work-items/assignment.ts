import { initDb } from '../shared/db.js';
import { notifyTodoStatusChange } from './live-events.js';
import type { WriteOrigin } from './origin.js';
import {
  appendWorkItemEvent,
  ensureDepartmentRegistered,
  getWorkItem,
  STICKY_STATUSES,
  type AppendWorkItemEventInput,
  type WorkItem,
  type WorkItemStatus,
} from './store.js';
import { todoProvenanceSnapshot, TransitionError, type TransitionResult } from './transitions.js';

/**
 * The assignment write. It moves status as a side effect (backlog→assigned), so
 * it borrows `transitions.ts`'s audit shape and its live listener rather than
 * inventing a second one — but WHO owns a Todo is a different question from
 * where it sits in its lifecycle, and only this path answers it.
 */

interface Assignment {
  assignee: string;
  department: string | null;
  actor?: string | null;
  origin?: WriteOrigin;
}

/** A reassignment that leaves the Todo where it sits is a `note`, not a status
 *  change: the audit reads the difference, so the event has to state it. */
function assignmentEvent(
  item: WorkItem,
  target: WorkItemStatus,
  { assignee, department, actor, origin }: Assignment,
): AppendWorkItemEventInput {
  const moved = item.status !== target;
  return {
    workItemId: item.id,
    kind: moved ? 'status_change' : 'note',
    fromStatus: moved ? item.status : null,
    toStatus: moved ? target : null,
    actor: actor ?? null,
    detail: {
      assignee,
      department,
      ...(origin ? { origin } : {}),
      todoProvenance: todoProvenanceSnapshot({ source: item.source, department, assignee }),
    },
    versionEffect: 'companion',
  };
}

/** Assign a Todo to an employee. Roster validation lives at the route layer; this
 * is the only assignment path, so backlog→assigned emits the same committed
 * status event and live todo-status listener notification as any other
 * lifecycle move. */
export function assignWorkItem(
  id: string,
  assignee: string,
  department: string | null,
  actor?: string | null,
  origin?: WriteOrigin,
): WorkItem | undefined {
  const db = initDb();
  const txn = db.transaction((): TransitionResult | undefined => {
    const item = getWorkItem(id);
    if (!item) return undefined;
    if (STICKY_STATUSES.has(item.status)) {
      throw new TransitionError('illegal-edge', `cannot assign work item ${id} while it is in terminal state ${item.status}`);
    }
    const target = item.status === 'backlog' ? 'assigned' : item.status;
    if (item.assignee === assignee && item.department === department && item.status === target) {
      return { item, escalated: false };
    }
    if (department !== null) ensureDepartmentRegistered(department); // review F2: same-transaction registry mint
    const now = new Date().toISOString();
    const result = db
      .prepare('UPDATE work_items SET assignee = ?, department = ?, status = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = ?')
      .run(assignee, department, target, now, id, item.status);
    if (result.changes === 0) {
      throw new TransitionError('conflict', `work item ${id} changed concurrently (expected status ${item.status})`);
    }
    const event = appendWorkItemEvent(assignmentEvent(item, target, { assignee, department, actor, origin }));
    return { item: getWorkItem(id)!, escalated: false, event };
  });
  const result = txn();
  if (!result) return undefined;
  notifyTodoStatusChange(result.event, result.item);
  return result.item;
}
