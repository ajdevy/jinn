import type Database from "better-sqlite3";

const READINGS_COLUMNS = `
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  at TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  note TEXT,
  FOREIGN KEY (experiment_id, metric)
    REFERENCES experiment_metrics(experiment_id, name) ON DELETE CASCADE
`;

const EXPERIMENTS_TABLES_DDL = `
CREATE TABLE IF NOT EXISTS experiments (
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
  check_in_cron_job_id TEXT,
  todo_id TEXT,
  owner TEXT
);

CREATE TABLE IF NOT EXISTS experiment_metrics (
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  name TEXT NOT NULL,
  unit TEXT,
  how_to_measure TEXT NOT NULL,
  PRIMARY KEY (experiment_id, name)
);

CREATE TABLE IF NOT EXISTS experiment_readings (${READINGS_COLUMNS});
`;

const EXPERIMENTS_INDEXES_DDL = `
CREATE INDEX IF NOT EXISTS idx_experiments_status_started
  ON experiments(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_experiment_metrics_order
  ON experiment_metrics(experiment_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_experiment_readings_order
  ON experiment_readings(experiment_id, at, id);
`;

// experiment_readings first shipped with no ON DELETE action on its composite
// foreign key, which made deleting an experiment fail outright: the readings
// held their metrics in place and blocked the experiments → metrics cascade.
// CREATE TABLE IF NOT EXISTS cannot change that, so an existing table carrying
// the old shape is rebuilt. Readings are copied after their parents already
// exist, so the copy satisfies the foreign key it is being given.
function rebuildReadingsWithCascade(db: Database.Database): void {
  const existing = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'experiment_readings'",
  ).pluck().get() as string | undefined;
  if (!existing || /ON DELETE CASCADE/i.test(existing)) return;
  db.exec(`
    CREATE TABLE experiment_readings_rebuilt (${READINGS_COLUMNS});
    INSERT INTO experiment_readings_rebuilt (id, experiment_id, at, metric, value, note)
      SELECT id, experiment_id, at, metric, value, note FROM experiment_readings;
    DROP TABLE experiment_readings;
    ALTER TABLE experiment_readings_rebuilt RENAME TO experiment_readings;
  `);
}

// todo_id and owner arrived after experiments shipped, and CREATE TABLE IF NOT
// EXISTS leaves an existing table exactly as it found it. Both are nullable,
// which is what an unlinked experiment stores anyway, so existing rows need no
// backfill — only the columns.
function addLinkColumns(db: Database.Database): void {
  const present = new Set(
    (db.prepare("PRAGMA table_info(experiments)").all() as { name: string }[]).map((column) => column.name),
  );
  if (!present.has("todo_id")) db.exec("ALTER TABLE experiments ADD COLUMN todo_id TEXT");
  if (!present.has("owner")) db.exec("ALTER TABLE experiments ADD COLUMN owner TEXT");
}

export function migrateExperimentsSchema(db: Database.Database): void {
  db.exec(EXPERIMENTS_TABLES_DDL);
  addLinkColumns(db);
  // Before the indexes: the rebuild drops the table they cover with it.
  rebuildReadingsWithCascade(db);
  db.exec(EXPERIMENTS_INDEXES_DDL);
}
