import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { WORK_ITEM_KEPT_DDL } from "../kept.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-kept-schema-"));
process.env.JINN_HOME = tmp;

type Migrate = typeof import("../migrate.js");
let migrate: Migrate;

beforeAll(async () => {
  migrate = await import("../migrate.js");
});

const shape = (sql: string | undefined) =>
  (sql ?? "").replace(/\bIF\s+NOT\s+EXISTS\b/gi, "").replace(/\s+/g, " ").replace(/;\s*$/, "").trim().toLowerCase();

function freshDatabase(name: string): { file: string; db: import("better-sqlite3").Database } {
  const file = path.join(tmp, name);
  const db = new Database(file);
  migrate.migrateWorkItemsSchema(db, "absent");
  return { file, db };
}

function storedSql(db: import("better-sqlite3").Database, table: string): string | undefined {
  return (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined)?.sql;
}

const SEEDED_AT = "2026-01-01T00:00:00.000Z";

/** One real Todo through the allocator, so the identity triggers are satisfied. */
function seed(db: import("better-sqlite3").Database, createdBy: string): string {
  migrate.registerWorkItemIdentityFunctions(db);
  const claim = migrate.allocateWorkItemId(db, SEEDED_AT, "JIN");
  migrate.useWorkItemAllocationClaim(db, claim, () => {
    db.prepare(
      `INSERT INTO work_items (id, title, status, priority, version, source, rounds, created_by, root_id, depth, created_at, updated_at)
       VALUES (?, 'seeded', 'backlog', 2, 1, 'human', 0, ?, ?, 0, ?, ?)`,
    ).run(claim.id, createdBy, claim.id, SEEDED_AT, SEEDED_AT);
  });
  return claim.id;
}

const keptIds = (db: import("better-sqlite3").Database): string[] =>
  db.prepare("SELECT work_item_id FROM work_item_kept ORDER BY work_item_id").pluck().all() as string[];

/* ICI-1357 lands in a new table, never a column: `verifyCurrentWorkItemSchema`
 * compares every stored table DDL byte-for-byte, so a column on `work_items`
 * would make every deployed database refuse to boot. */
describe("work_item_kept is additive", () => {
  it("is created on a fresh database at its frozen shape, and verifies", () => {
    const { db } = freshDatabase("fresh.db");
    expect(shape(storedSql(db, "work_item_kept"))).toBe(shape(WORK_ITEM_KEPT_DDL));
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).not.toThrow();
    db.close();
  });

  it("heals a database that predates the table: classified current, table gained, work_items untouched", () => {
    const { file, db } = freshDatabase("heal.db");
    db.exec("DROP TABLE work_item_kept");
    const workItemsBefore = storedSql(db, "work_items");
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).toThrow(migrate.UNSUPPORTED_PRERELEASE_TODO_DATA);
    db.close();

    expect(migrate.preflightWorkItemsDatabase(file)).toBe("current");

    const healed = new Database(file);
    expect(migrate.migrateWorkItemsSchema(healed, "current").rebuilt).toBe(false);
    expect(storedSql(healed, "work_item_kept")).toBeTypeOf("string");
    expect(storedSql(healed, "work_items")).toBe(workItemsBefore);
    expect(() => migrate.verifyCurrentWorkItemSchema(healed)).not.toThrow();
    healed.close();
  });

  it("refuses at preflight when the table is present at a different shape", () => {
    const { file, db } = freshDatabase("drift.db");
    db.exec("DROP TABLE work_item_kept");
    db.exec("CREATE TABLE work_item_kept (work_item_id TEXT PRIMARY KEY)");
    db.close();
    expect(() => migrate.preflightWorkItemsDatabase(file)).toThrow(migrate.UNSUPPORTED_PRERELEASE_TODO_DATA);
  });
});

/* Criterion 3: every Todo "My requests" showed before the upgrade — which was
 * exactly `created_by = 'operator'` — is on Home after it. */
describe("the upgrade carries My requests onto Home", () => {
  it("backfills one row per operator-created Todo, and none for the agents'", () => {
    const { file, db } = freshDatabase("backfill.db");
    db.exec("DROP TABLE work_item_kept");
    const mine = seed(db, "operator");
    seed(db, "session:agent-1");
    const alsoMine = seed(db, "operator");
    const myRequests = db.prepare("SELECT id FROM work_items WHERE created_by = 'operator' ORDER BY id").pluck().all();
    db.close();

    const healed = new Database(file);
    migrate.migrateWorkItemsSchema(healed, "current");
    expect(keptIds(healed)).toEqual(myRequests);
    expect(keptIds(healed)).toEqual([mine, alsoMine].sort());
    healed.close();
  });

  it("carries `created_at` across, so Home does not reorder on the upgrade", () => {
    const { file, db } = freshDatabase("backfill-at.db");
    db.exec("DROP TABLE work_item_kept");
    const id = seed(db, "operator");
    db.close();

    const healed = new Database(file);
    migrate.migrateWorkItemsSchema(healed, "current");
    expect(healed.prepare("SELECT kept_at FROM work_item_kept WHERE work_item_id = ?").pluck().get(id)).toBe(SEEDED_AT);
    healed.close();
  });
});

/* Criterion 4. Without the `keptIsNew` guard in migrate.ts these two go red:
 * the second migration re-runs the backfill and the unkept Todo comes back. */
describe("the backfill runs exactly once", () => {
  it("does not duplicate rows on a second migration", () => {
    const { file, db } = freshDatabase("twice.db");
    db.exec("DROP TABLE work_item_kept");
    seed(db, "operator");
    db.close();

    for (const _pass of [1, 2]) {
      const boot = new Database(file);
      migrate.migrateWorkItemsSchema(boot, "current");
      boot.close();
    }
    const check = new Database(file);
    expect(check.prepare("SELECT COUNT(*) FROM work_item_kept").pluck().get()).toBe(1);
    check.close();
  });

  it("never re-keeps a Todo the operator has since unkept", () => {
    const { file, db } = freshDatabase("unkept.db");
    db.exec("DROP TABLE work_item_kept");
    const id = seed(db, "operator");
    db.close();

    const upgraded = new Database(file);
    migrate.migrateWorkItemsSchema(upgraded, "current");
    expect(keptIds(upgraded)).toEqual([id]);
    upgraded.prepare("DELETE FROM work_item_kept WHERE work_item_id = ?").run(id); // the operator unkeeps it
    upgraded.close();

    const rebooted = new Database(file);
    migrate.migrateWorkItemsSchema(rebooted, "current");
    expect(keptIds(rebooted)).toEqual([]);
    rebooted.close();
  });
});
