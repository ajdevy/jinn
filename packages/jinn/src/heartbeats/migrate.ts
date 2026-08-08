import type Database from "better-sqlite3";

const HEARTBEATS_DDL = `
CREATE TABLE IF NOT EXISTS heartbeats (
  id TEXT PRIMARY KEY,
  owner_session_id TEXT NOT NULL,
  message TEXT NOT NULL CHECK (length(message) > 0),
  every_seconds INTEGER NOT NULL CHECK (every_seconds > 0),
  next_fire_at INTEGER NOT NULL,
  fire_count INTEGER NOT NULL DEFAULT 0 CHECK (fire_count >= 0),
  max_fires INTEGER CHECK (max_fires IS NULL OR max_fires > 0),
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'armed' CHECK (status IN ('armed', 'disarmed')),
  created_at TEXT NOT NULL,
  disarmed_at TEXT,
  disarmed_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_heartbeats_due
  ON heartbeats(next_fire_at) WHERE status = 'armed';
CREATE INDEX IF NOT EXISTS idx_heartbeats_owner
  ON heartbeats(owner_session_id, status);
`;

export function migrateHeartbeatsSchema(db: Database.Database): void {
  db.exec(HEARTBEATS_DDL);
}
