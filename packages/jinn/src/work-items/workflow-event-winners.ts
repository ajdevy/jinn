import { CLAIMS_TABLE, ensureClaimsTable, parseOutcomes } from './workflow-event-feed.js';

/** The bound on how far back a lookup reads, matching the pending list's own
 *  page. A Todo carrying more settled status events than this above one arming
 *  move has a bigger problem than a stale event. */
const SETTLED_PAGE = 500;

/**
 * For every workflow a NEWER event on the same Todo has already started, the id
 * of that event.
 *
 * Supersession picks the newest qualifying event, and the pending list answers
 * that for siblings still waiting their turn. It cannot answer it for one that
 * has already run: a settled event is no longer pending, and past the page's own
 * limit an unsettled one is not there either. So an event that re-enters the
 * drain later — a deferral released when its label finally landed — would see an
 * empty gate and start a second run on a lane a newer event has already taken.
 *
 * "Newer" is strict, and by the same `created_at, rowid` key the pending list
 * orders on, so every event named here is truthfully newer than the one asking.
 */
export function startedAfterEvent(eventId: string): Map<string, string> {
  const rows = ensureClaimsTable().prepare(
    `SELECT e.id AS event_id, c.outcomes
     FROM work_item_events anchor
     JOIN work_item_events e ON e.work_item_id = anchor.work_item_id
     JOIN ${CLAIMS_TABLE} c ON c.event_id = e.id
     WHERE anchor.id = ?
       AND (e.created_at > anchor.created_at
         OR (e.created_at = anchor.created_at AND e.rowid > anchor.rowid))
       AND c.state = 'processed'
     ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`,
  ).all(eventId, SETTLED_PAGE) as Array<{ event_id: string; outcomes: string | null }>;
  const winners = new Map<string, string>();
  for (const row of rows) {
    for (const outcome of parseOutcomes(row.outcomes)) {
      if (outcome.outcome === 'started' && !winners.has(outcome.workflowId)) {
        winners.set(outcome.workflowId, row.event_id);
      }
    }
  }
  return winners;
}
