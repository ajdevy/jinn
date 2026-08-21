// Row model and queries for the queue_items table — the durable per-session
// turn queue. Split out of `registry.ts`, which owns the sessions and messages
// side of the same database; the table's DDL lives in `queue-items-schema.ts`.
import { randomUUID } from 'node:crypto';
import { initDb } from '../shared/db.js';

export interface QueueItem {
  id: string;
  sessionId: string;
  sessionKey: string;
  prompt: string;
  status: "pending" | "running" | "cancelled" | "completed";
  internal: boolean;
  position: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface QueueItemRow extends Omit<QueueItem, "internal"> {
  internal: number;
}

function rowToQueueItem(row: QueueItemRow): QueueItem {
  return { ...row, internal: row.internal === 1 };
}

const QUEUE_ITEM_SELECT =
  "SELECT id, session_id as sessionId, session_key as sessionKey, prompt, status, internal, position, created_at as createdAt, started_at as startedAt, completed_at as completedAt FROM queue_items";

export function enqueueQueueItem(
  sessionId: string,
  sessionKey: string,
  prompt: string,
  options: { internal?: boolean } = {},
): string {
  const db = initDb();
  const id = randomUUID();
  const position = (db.prepare(
    "SELECT COALESCE(MAX(position), 0) + 1 as pos FROM queue_items WHERE session_key = ? AND status = 'pending'"
  ).get(sessionKey) as { pos: number }).pos;
  db.prepare(
    "INSERT INTO queue_items (id, session_id, session_key, prompt, status, internal, position, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)"
  ).run(id, sessionId, sessionKey, prompt, options.internal ? 1 : 0, position, new Date().toISOString());
  return id;
}

export function markQueueItemRunning(itemId: string): boolean {
  const db = initDb();
  return db.prepare("UPDATE queue_items SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'")
    .run(new Date().toISOString(), itemId).changes === 1;
}

export function markQueueItemCompleted(itemId: string): void {
  const db = initDb();
  db.prepare("UPDATE queue_items SET status = 'completed', completed_at = ? WHERE id = ?")
    .run(new Date().toISOString(), itemId);
}

export function markRunningQueueItemsCompletedForSession(sessionId: string): number {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'completed', completed_at = ? WHERE session_id = ? AND status = 'running'"
  ).run(new Date().toISOString(), sessionId);
  return result.changes;
}

export function getQueueItem(itemId: string): QueueItem | undefined {
  const db = initDb();
  const row = db.prepare(`${QUEUE_ITEM_SELECT} WHERE id = ?`).get(itemId) as QueueItemRow | undefined;
  return row ? rowToQueueItem(row) : undefined;
}

export function cancelQueueItem(itemId: string): boolean {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'cancelled' WHERE id = ? AND status = 'pending'"
  ).run(itemId);
  return result.changes > 0;
}

export function getQueueItems(sessionKey: string): QueueItem[] {
  const db = initDb();
  const rows = db.prepare(
    `${QUEUE_ITEM_SELECT} WHERE session_key = ? AND internal = 0 AND status IN ('pending', 'running') ORDER BY position ASC`
  ).all(sessionKey) as QueueItemRow[];
  return rows.map(rowToQueueItem);
}

export function cancelAllPendingQueueItems(sessionKey: string): number {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'cancelled' WHERE session_key = ? AND internal = 0 AND status = 'pending'"
  ).run(sessionKey);
  return result.changes;
}

export function recoverStaleQueueItems(): number {
  const db = initDb();
  // If the gateway restarts mid-run, move any "running" items back to "pending"
  // so they can be replayed. Do NOT cancel pending work.
  const result = db.prepare(
    `UPDATE queue_items
     SET status = 'pending', started_at = NULL
     WHERE status = 'running'
       AND NOT EXISTS (
         SELECT 1 FROM sessions
         WHERE sessions.id = queue_items.session_id
           AND sessions.workflow_kind IS NOT NULL
       )`
  ).run();
  return result.changes;
}

export function listAllPendingQueueItems(): QueueItem[] {
  const db = initDb();
  const rows = db.prepare(
    `${QUEUE_ITEM_SELECT} WHERE status = 'pending' ORDER BY created_at ASC, position ASC`
  ).all() as QueueItemRow[];
  return rows.map(rowToQueueItem);
}

export function claimWorkflowAttemptDispatch(sessionId: string, sessionKey: string, prompt: string): string | null {
  const db = initDb(); return db.transaction(() => {
    const session = db.prepare(`SELECT id FROM sessions WHERE id = ? AND session_key = ?
      AND workflow_kind = 'phase' AND status = 'idle'
      AND (attempt_outcome IS NULL OR attempt_outcome = 'succeeded')`).get(sessionId, sessionKey);
    if (!session) return null;
    const existing = db.prepare(`${QUEUE_ITEM_SELECT} WHERE session_id = ? AND internal = 1 AND status IN ('pending', 'running') ORDER BY created_at, position LIMIT 1`).get(sessionId) as QueueItemRow | undefined;
    if (existing && (existing.sessionKey !== sessionKey || existing.prompt !== prompt)) throw new Error(`Workflow session ${sessionId} dispatch claim does not match its immutable command.`);
    if (existing?.status === 'running') return null; const itemId = existing?.id ?? enqueueQueueItem(sessionId, sessionKey, prompt, { internal: true });
    return itemId; }).immediate();
}
export function cancelWorkflowAttemptDispatch(sessionId: string): number { return initDb().prepare(`UPDATE queue_items SET status = 'cancelled' WHERE session_id = ? AND internal = 1 AND status IN ('pending', 'running')`).run(sessionId).changes; }
export function listPendingWorkflowAttemptDispatches(): QueueItem[] {
  return (initDb().prepare(`${QUEUE_ITEM_SELECT} WHERE status = 'pending' AND internal = 1
    AND EXISTS (SELECT 1 FROM sessions WHERE sessions.id = queue_items.session_id
      AND sessions.workflow_kind = 'phase' AND sessions.status = 'idle'
      AND (sessions.attempt_outcome IS NULL OR sessions.attempt_outcome = 'succeeded'))
    ORDER BY created_at, position`).all() as QueueItemRow[]).map(rowToQueueItem);
}
