import { beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-experiments-migrate-"));
process.env.JINN_HOME = home;

type Store = typeof import("../store.js");
type Migrate = typeof import("../migrate.js");
let store: Store;
let migrate: Migrate;
let db: import("better-sqlite3").Database;

// The shape experiment_readings shipped with before the cascade fix: a composite
// foreign key with no ON DELETE action, which blocked its parent's cascade.
const OLD_SCHEMA = `
CREATE TABLE experiments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'concluded')),
  started_at TEXT NOT NULL,
  horizon_days INTEGER NOT NULL CHECK (horizon_days > 0),
  baseline_json TEXT NOT NULL,
  verdict_outcome TEXT CHECK (verdict_outcome IN ('win', 'loss', 'inconclusive')),
  verdict_note TEXT,
  concluded_at TEXT,
  check_in_cron_job_id TEXT
);
CREATE TABLE experiment_metrics (
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  name TEXT NOT NULL,
  unit TEXT,
  how_to_measure TEXT NOT NULL,
  PRIMARY KEY (experiment_id, name)
);
CREATE TABLE experiment_readings (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  at TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  note TEXT,
  FOREIGN KEY (experiment_id, metric)
    REFERENCES experiment_metrics(experiment_id, name)
);
INSERT INTO experiments VALUES
  ('exp_aaaaaaaaaaaa', 'Legacy', 'A legacy row survives the rebuild.', 'running',
   '2026-07-01T09:00:00.000Z', 30, '{"activation":21}', NULL, NULL, NULL, NULL);
INSERT INTO experiment_metrics VALUES ('exp_aaaaaaaaaaaa', 0, 'activation', '%', 'Read the dashboard.');
INSERT INTO experiment_readings VALUES
  ('rd_aaaaaaaaaaaa', 'exp_aaaaaaaaaaaa', '2026-07-08T09:00:00.000Z', 'activation', 23, NULL),
  ('rd_bbbbbbbbbbbb', 'exp_aaaaaaaaaaaa', '2026-07-15T09:00:00.000Z', 'activation', 27, 'Second week');
`;

function readingsOf(database: import("better-sqlite3").Database) {
  return database.prepare("SELECT id, at, metric, value, note FROM experiment_readings ORDER BY at").all();
}

function legacyDatabase(): import("better-sqlite3").Database {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jinn-experiments-old-")), "legacy.db");
  const legacy = new Database(file);
  legacy.exec(OLD_SCHEMA);
  return legacy;
}

function readingsTableSql(database: import("better-sqlite3").Database): string {
  return database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'experiment_readings'",
  ).pluck().get() as string;
}

beforeAll(async () => {
  store = await import("../store.js");
  migrate = await import("../migrate.js");
  db = (await import("../../shared/db.js")).initDb();
});

describe("experiments schema migration", () => {
  it("enforces foreign keys on the initialized connection", () => {
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("cascades metrics and readings away when an experiment row is deleted", () => {
    const created = store.createExperiment({
      name: "Cascade",
      hypothesis: "Deleting the parent removes both children.",
      baseline: { activation: 21 },
      metrics: [{ name: "activation", unit: "%", howToMeasure: "Read the dashboard." }],
      horizonDays: 30,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.detail);
    const recorded = store.recordReading(created.value.id, {
      at: "2026-08-01T12:00:00.000Z",
      metric: "activation",
      value: 25,
    });
    expect(recorded.ok).toBe(true);

    expect(() => db.prepare("DELETE FROM experiments WHERE id = ?").run(created.value.id)).not.toThrow();

    const remaining = (table: string) => db.prepare(
      `SELECT COUNT(*) FROM ${table} WHERE experiment_id = ?`,
    ).pluck().get(created.value.id);
    expect(remaining("experiment_metrics")).toBe(0);
    expect(remaining("experiment_readings")).toBe(0);
  });

  it("rebuilds an old-shape readings table without losing or duplicating readings", () => {
    const legacy = legacyDatabase();
    const before = readingsOf(legacy);
    expect(readingsTableSql(legacy)).not.toContain("ON DELETE CASCADE");

    migrate.migrateExperimentsSchema(legacy);

    expect(readingsTableSql(legacy)).toContain("ON DELETE CASCADE");
    expect(readingsOf(legacy)).toEqual(before);

    const afterFirst = readingsTableSql(legacy);
    migrate.migrateExperimentsSchema(legacy);
    expect(readingsTableSql(legacy)).toBe(afterFirst);
    expect(readingsOf(legacy)).toEqual(before);

    expect(() => legacy.prepare("DELETE FROM experiments WHERE id = ?").run("exp_aaaaaaaaaaaa")).not.toThrow();
    expect(readingsOf(legacy)).toEqual([]);
    legacy.close();
  });

  it("adds the Todo link and owner columns to a database that predates them", () => {
    const legacy = legacyDatabase();
    const columns = () => (legacy.prepare("PRAGMA table_info(experiments)").all() as { name: string }[])
      .map((column) => column.name);
    expect(columns()).not.toContain("todo_id");

    migrate.migrateExperimentsSchema(legacy);

    expect(columns()).toEqual(expect.arrayContaining(["todo_id", "owner"]));
    expect(legacy.prepare("SELECT name, todo_id, owner FROM experiments").all()).toEqual([
      { name: "Legacy", todo_id: null, owner: null },
    ]);

    migrate.migrateExperimentsSchema(legacy);
    expect(columns().filter((name) => name === "todo_id")).toHaveLength(1);
    legacy.close();
  });
});
