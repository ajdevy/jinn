import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { WORK_ITEM_RUNS_TABLE_DDL } from "../runs-schema.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-runs-schema-"));
process.env.JINN_HOME = tmp;

type Migrate = typeof import("../migrate.js");
let migrate: Migrate;

beforeAll(async () => {
  migrate = await import("../migrate.js");
});

/** A clean current-shape database, built the way the gateway builds one. */
function freshDatabase(name: string): { file: string; db: import("better-sqlite3").Database } {
  const file = path.join(tmp, name);
  const db = new Database(file);
  migrate.migrateWorkItemsSchema(db, "absent");
  return { file, db };
}

describe("work_item_runs in the frozen schema", () => {
  it("is created on a fresh database with the exact frozen DDL and verifies", () => {
    const { db } = freshDatabase("fresh.db");
    const stored = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'work_item_runs'")
      .get() as { sql: string }).sql;
    const shape = (sql: string) => sql.replace(/\bIF\s+NOT\s+EXISTS\b/gi, "").replace(/\s+/g, " ").trim().toLowerCase();
    expect(shape(stored)).toBe(shape(WORK_ITEM_RUNS_TABLE_DDL));
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).not.toThrow();
    db.close();
  });

  it("heals a v2 database that predates the table, and still verifies", () => {
    const { file, db } = freshDatabase("heal.db");
    db.exec("DROP TABLE work_item_runs");
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).toThrow(migrate.UNSUPPORTED_PRERELEASE_TODO_DATA);
    db.close();

    expect(migrate.preflightWorkItemsDatabase(file)).toBe("current");

    const healed = new Database(file);
    expect(migrate.migrateWorkItemsSchema(healed, "current").rebuilt).toBe(false);
    expect(() => migrate.verifyCurrentWorkItemSchema(healed)).not.toThrow();
    healed.close();
  });

  it("refuses at preflight when the table exists with a different shape", () => {
    const { file, db } = freshDatabase("drift.db");
    db.exec("DROP TABLE work_item_runs");
    db.exec("CREATE TABLE work_item_runs (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, outcome TEXT)");
    db.close();
    expect(() => migrate.preflightWorkItemsDatabase(file)).toThrow(migrate.UNSUPPORTED_PRERELEASE_TODO_DATA);
  });

  it("refuses a run row whose outcome is outside the five the ledger knows", () => {
    const { db } = freshDatabase("bad-outcome.db");
    // The CHECK stops the honest write path; the boot verifier re-proves the
    // data for a database that reached this state some other way.
    expect(() =>
      db.prepare(
        `INSERT INTO work_item_runs (id, work_item_id, session_id, started_at, ended_at, outcome)
         VALUES ('wir_00000000000a', 'JIN-1', 's', '2026-08-13T00:00:00.000Z', '2026-08-13T00:01:00.000Z', 'succeeded')`,
      ).run(),
    ).toThrow(/CHECK/i);
    db.close();
  });

  it("refuses a half-settled run: an end without an outcome, or an outcome without an end", () => {
    const { db } = freshDatabase("half.db");
    const insert = (endedAt: string | null, outcome: string | null) =>
      db.prepare(
        `INSERT INTO work_item_runs (id, work_item_id, session_id, started_at, ended_at, outcome)
         VALUES ('wir_00000000000b', 'JIN-1', 's', '2026-08-13T00:00:00.000Z', ?, ?)`,
      ).run(endedAt, outcome);
    expect(() => insert("2026-08-13T00:01:00.000Z", null)).toThrow(/CHECK/i);
    expect(() => insert(null, "completed")).toThrow(/CHECK/i);
    db.close();
  });
});
