/** What a Todo-data migration refuses with, and the signal that picks which
 *  refusal it is. Kept apart from the migration itself because these are the two
 *  sentences an operator actually reads when the gateway will not start, and
 *  they have to stay recognizable — `shared/db.ts` matches one of them by value
 *  to tell "this database is not ours to migrate" from "this file is broken". */

export const UNSUPPORTED_PRERELEASE_TODO_DATA =
  "Unsupported prerelease Todo data detected. This release cannot start or migrate it.\n" +
  "Use the separately reviewed offline converter, or restore a supported public-version backup.";

export const CORRUPT_SESSIONS_DATABASE =
  "The session database appears to be corrupt or is not a valid SQLite file — this is NOT a Todo-data\n" +
  "problem. Restore it from a backup (check the 'backups/' folder next to registry.db, or your most\n" +
  "recent copy) and restart.";

/** SQLite surfaces file corruption via these substrings. */
export function isSqliteCorruption(message: string): boolean {
  return /malformed|file is not a database|not a database|disk image is malformed|database is locked.*corrupt|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(
    message,
  );
}
