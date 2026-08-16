// Row model and queries for the files table — uploaded attachments and the
// managed files an agent writes. Split out of `registry.ts`, which owns the
// sessions and messages side of the same database.
import { initDb } from '../shared/db.js';

export interface FileMeta {
  id: string;
  filename: string;
  size: number;
  mimetype: string | null;
  path: string | null;
  /** Displayed pixel size for images, null for everything else and for rows
   * stored before dimensions were recorded. */
  width: number | null;
  height: number | null;
  createdAt: string;
}

function rowToFileMeta(row: Record<string, unknown>): FileMeta {
  return {
    id: row.id as string,
    filename: row.filename as string,
    size: row.size as number,
    mimetype: (row.mimetype as string) ?? null,
    path: (row.path as string) ?? null,
    width: (row.width as number) ?? null,
    height: (row.height as number) ?? null,
    createdAt: row.created_at as string,
  };
}

export function insertFile(meta: {
  id: string;
  filename: string;
  size: number;
  mimetype: string | null;
  path: string | null;
  width?: number | null;
  height?: number | null;
}): FileMeta {
  const db = initDb();
  const now = new Date().toISOString();
  const width = meta.width ?? null;
  const height = meta.height ?? null;
  db.prepare('INSERT INTO files (id, filename, size, mimetype, path, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    meta.id, meta.filename, meta.size, meta.mimetype, meta.path, width, height, now,
  );
  return { ...meta, width, height, createdAt: now };
}

export function getFile(id: string): FileMeta | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToFileMeta(row) : undefined;
}

export function listFiles(): FileMeta[] {
  const db = initDb();
  const rows = db.prepare('SELECT * FROM files ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(rowToFileMeta);
}

export function deleteFile(id: string): boolean {
  const db = initDb();
  const result = db.prepare('DELETE FROM files WHERE id = ?').run(id);
  return result.changes > 0;
}

/** Update the recorded on-disk path for a file (used when re-homing into the uploads dir). */
export function setFilePath(id: string, filePath: string): void {
  const db = initDb();
  db.prepare('UPDATE files SET path = ? WHERE id = ?').run(filePath, id);
}
