// Durable acceptance of one incoming turn: the chat message and, for a
// notification, the internal queue row that makes it survive a crash before
// dispatch. Split out of `gateway/api.ts` so the two writes commit together and
// so an agent-initiated send can carry an idempotency identity.
import { createHash, randomUUID } from 'node:crypto';
import { initDb } from '../shared/db.js';
import { insertMessage, type MessageMedia } from './registry.js';
import type { JsonObject } from '../shared/types.js';

/**
 * The durable identity of one agent-initiated (lateral) send.
 *
 * Derived from the send's CONTENT — caller, target, message — rather than from
 * the MCP call's `x-jinn-activity-operation` id, because that id is minted per
 * `tools/call` inside the MCP server process: a transport replay of the same
 * pending call re-mints it, so it cannot name the retry it would have to
 * collapse. Caller, target and message body survive the replay and can.
 */
export function lateralSendDedupeKey(callerSessionId: string, targetSessionId: string, message: string): string {
  const digest = createHash('sha256').update(message).digest('hex');
  return `lateral:${callerSessionId}:${targetSessionId}:${digest}`;
}

export type IncomingTurnClaim =
  | { deduplicated: true; queueItemId: string }
  | { deduplicated: false; queueItemId?: string; messageId: string };

export interface IncomingTurn {
  sessionId: string;
  sessionKey: string;
  /** Engine-facing text, queued verbatim so a crash before dispatch replays it. */
  prompt: string;
  /** Notifications queue a durable internal intent; user messages are enqueued
   *  by the caller as a visible queue-panel item instead. */
  isNotification: boolean;
  role: string;
  /** What the transcript stores — the display banner for a notification. */
  content: string;
  media?: MessageMedia[];
  meta?: JsonObject;
  /** Set only for tool-origin lateral sends; absent means no dedupe at all, so
   *  the operator/UI path is unchanged. */
  dedupeKey?: string;
}

/**
 * Accept an incoming turn in ONE transaction, so a failed message write can
 * never leave an orphan queue row behind (or the reverse).
 *
 * With a `dedupeKey`, the partial unique index on `queue_items.dedupe_key` is
 * the concurrency arbiter: a replayed send inserts nothing, writes no second
 * message, and reuses the winning row's id — the same shape
 * `claimSessionDelivery` gives the child-callback outbox.
 */
export function claimIncomingTurn(turn: IncomingTurn): IncomingTurnClaim {
  const db = initDb();
  const claim = db.transaction((): IncomingTurnClaim => {
    let queueItemId: string | undefined;
    if (turn.isNotification) {
      queueItemId = randomUUID();
      const position = (db.prepare(
        "SELECT COALESCE(MAX(position), 0) + 1 as pos FROM queue_items WHERE session_key = ? AND status = 'pending'",
      ).get(turn.sessionKey) as { pos: number }).pos;
      const inserted = db.prepare(
        `INSERT INTO queue_items (id, session_id, session_key, prompt, status, internal, position, created_at, dedupe_key)
         VALUES (?, ?, ?, ?, 'pending', 1, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).run(queueItemId, turn.sessionId, turn.sessionKey, turn.prompt, position, new Date().toISOString(), turn.dedupeKey ?? null);
      if (inserted.changes === 0) {
        const winner = db.prepare(
          "SELECT id FROM queue_items WHERE dedupe_key = ? AND status IN ('pending', 'running')",
        ).get(turn.dedupeKey) as { id: string } | undefined;
        if (!winner) throw new Error(`queue item for session ${turn.sessionId} conflicted with no live row holding its dedupe key`);
        return { deduplicated: true, queueItemId: winner.id };
      }
    }
    const messageId = insertMessage(turn.sessionId, turn.role, turn.content, turn.media, undefined, undefined, turn.meta);
    return { deduplicated: false, queueItemId, messageId };
  });
  return claim.immediate();
}
