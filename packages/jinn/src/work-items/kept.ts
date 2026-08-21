import type { Database as DatabaseType } from "better-sqlite3";

/** ICI-1357: the Todos the operator keeps on Home.
 *
 *  Home used to be `created_by = 'operator'`, so a Todo an agent raised was
 *  reachable only from its department board. Keeping is the operator's gesture
 *  for "follow this one", and creating a Todo as the operator keeps it — which
 *  is what lets one board replace both "My requests" and a separate Following.
 *
 *  Additive, never a column on `work_items`: the exact-shape verifier refuses
 *  any drift in an existing table, so a new table is the only extension a
 *  deployed database can survive.
 *
 *  Keyed by Todo alone, documented as the operator's. This gateway has one
 *  operator; a second one needs an actor column, which is a forward migration
 *  rather than a rewrite.
 *
 *  Every function takes the caller's `db` so it composes inside the caller's
 *  transaction — and so this module never imports the database opener, which
 *  would close a cycle back through `migrate.ts`. */
export const WORK_ITEM_KEPT_DDL = `
CREATE TABLE IF NOT EXISTS work_item_kept (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
  kept_at      TEXT NOT NULL
)`;

/** The Home board's whole scope, as a correlated EXISTS that the list query
 *  AND-composes like any other filter. It lives here so the table's one reader
 *  in SQL sits with the table. */
export const KEPT_EXISTS_SQL = "EXISTS (SELECT 1 FROM work_item_kept k WHERE k.work_item_id = work_items.id)";

/** Keep a Todo; true when it was not already kept. Idempotent, and keeping a
 *  kept Todo leaves the original `kept_at` alone, so Home does not reshuffle
 *  when something re-keeps what is already there. */
export function keepWorkItem(db: DatabaseType, workItemId: string, at: string): boolean {
  return db
    .prepare("INSERT OR IGNORE INTO work_item_kept (work_item_id, kept_at) VALUES (?, ?)")
    .run(workItemId, at).changes > 0;
}

/** Set the Todo's kept state. Returns whether this changed anything, so a
 *  caller can audit a real change and stay silent about a repeat. */
export function setWorkItemKept(db: DatabaseType, workItemId: string, kept: boolean): boolean {
  if (kept) return keepWorkItem(db, workItemId, new Date().toISOString());
  return db.prepare("DELETE FROM work_item_kept WHERE work_item_id = ?").run(workItemId).changes > 0;
}

export function isWorkItemKept(db: DatabaseType, workItemId: string): boolean {
  return !!db.prepare("SELECT 1 FROM work_item_kept WHERE work_item_id = ?").get(workItemId);
}

/** Batch form for list payloads: ONE query for the whole page, never per item. */
export function keptSet(db: DatabaseType, workItemIds: string[]): Set<string> {
  if (workItemIds.length === 0) return new Set();
  const placeholders = workItemIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT work_item_id FROM work_item_kept WHERE work_item_id IN (${placeholders})`)
    .pluck()
    .all(...workItemIds) as string[];
  return new Set(rows);
}

/** One-shot: every Todo the operator created is kept, so the set Home shows
 *  after the upgrade is the set "My requests" showed before it. Runs only on
 *  the boot that creates the table — re-running it would resurrect Todos the
 *  operator has since unkept, and unkeeping has to stick. */
export function backfillKeptFromCreatedBy(db: DatabaseType): number {
  return db
    .prepare(
      `INSERT OR IGNORE INTO work_item_kept (work_item_id, kept_at)
       SELECT id, created_at FROM work_items WHERE created_by = 'operator'`,
    )
    .run().changes;
}
