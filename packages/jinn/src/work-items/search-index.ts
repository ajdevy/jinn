import type { Database as DatabaseType } from "better-sqlite3";
import { currentTableSql } from "./sql-shape.js";

/**
 * Full-text search index over Todos and their comments (ICI-1369).
 *
 * Two external-content FTS5 tables, mirroring `messages_fts`
 * (`sessions/migrate.ts`): the index lives here and the text is read back from
 * `work_items` / `work_item_comments` by rowid, which is what lets `snippet()`
 * serve a per-row match reason. A contentless index could not.
 *
 * Currency is owned by SQL triggers, not by JS call sites — the store has three
 * distinct `UPDATE work_items SET` paths and comments mutate through insert,
 * edit, and tombstone — so every write moves the index inside the writer's own
 * transaction. There is no watermark machinery: `messages_fts` needs one only
 * because the message table is unbounded, while Todos and their comments number
 * in the thousands and seed synchronously.
 */

export const WORK_ITEMS_FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS work_items_fts USING fts5(title, body, content='work_items', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS work_items_fts_ai AFTER INSERT ON work_items BEGIN
  INSERT INTO work_items_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS work_items_fts_ad AFTER DELETE ON work_items BEGIN
  INSERT INTO work_items_fts(work_items_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS work_items_fts_au AFTER UPDATE ON work_items BEGIN
  INSERT INTO work_items_fts(work_items_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO work_items_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
`;

// A tombstone clears the comment body rather than deleting the row, so the AU
// trigger alone is what stops a deleted comment matching: it re-indexes '' .
export const WORK_ITEM_COMMENTS_FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS work_item_comments_fts USING fts5(body, content='work_item_comments', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS work_item_comments_fts_ai AFTER INSERT ON work_item_comments BEGIN
  INSERT INTO work_item_comments_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER IF NOT EXISTS work_item_comments_fts_ad AFTER DELETE ON work_item_comments BEGIN
  INSERT INTO work_item_comments_fts(work_item_comments_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER IF NOT EXISTS work_item_comments_fts_au AFTER UPDATE ON work_item_comments BEGIN
  INSERT INTO work_item_comments_fts(work_item_comments_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO work_item_comments_fts(rowid, body) VALUES (new.rowid, new.body);
END;
`;

const SEARCH_INDEXES: ReadonlyArray<{ table: string; ddl: string }> = [
  { table: "work_items_fts", ddl: WORK_ITEMS_FTS_DDL },
  { table: "work_item_comments_fts", ddl: WORK_ITEM_COMMENTS_FTS_DDL },
];

/**
 * Create whatever index is missing and seed it from its content table. Runs
 * from the composition root right after `migrateWorkItemsSchema`, in the same
 * boot transaction, the way `migrateFtsSchema` follows the messages schema.
 *
 * Create and backfill are decided together, per index, because an
 * external-content FTS5 table cannot report its own emptiness: `COUNT(*)` on it
 * reads the content table, not the index. So the backfill runs exactly when the
 * table was absent a statement ago, which is what makes a second run a no-op
 * that leaves index content identical. The DDL still re-runs unconditionally,
 * so a trigger lost with a recreated content table comes back.
 */
export function migrateWorkItemSearchIndex(db: DatabaseType): void {
  for (const { table, ddl } of SEARCH_INDEXES) {
    const seeded = currentTableSql(db, table) !== undefined;
    db.exec(ddl);
    if (!seeded) db.exec(`INSERT INTO ${table}(${table}) VALUES ('rebuild')`);
  }
}
