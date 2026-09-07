import { randomUUID } from "node:crypto";
import { initDb } from "../shared/db.js";

/** Bound replay protection to Telegram's normal pending-update horizon; this is not a permanent archive. */
export const TELEGRAM_INBOUND_DEDUPE_WINDOW_MS = 24 * 60 * 60_000;
/** A stuck in-flight claim must not block a replay forever in a live process. */
export const TELEGRAM_INBOUND_IN_FLIGHT_MAX_MS = 30 * 60_000;
const TELEGRAM_INBOUND_OWNER_ID = randomUUID();
const TELEGRAM_INBOUND_OWNER_PID = process.pid;

type TelegramInboundReceiptRow = {
  state: "in_flight" | "completed";
  owner_id: string;
  owner_pid: number;
  claimed_at: number;
  completed_at: number | null;
};

/** Telegram message IDs are unique within a chat; bot ID scopes duplicate bot instances. */
export function telegramInboundDedupeKey(
  botId: string | number,
  chatId: string | number,
  messageId: string | number,
): string {
  return `telegram:${String(botId)}:${String(chatId)}:${String(messageId)}`;
}

/**
 * Atomically claim an inbound Telegram message before any work is queued.
 * The receipt is durable so a restart cannot process an update twice, while the
 * cleanup keeps the table bounded and permits a legitimate later message ID reuse.
 */
export function claimTelegramInbound(
  dedupeKey: string,
  now = Date.now(),
  windowMs = TELEGRAM_INBOUND_DEDUPE_WINDOW_MS,
  ownerId = TELEGRAM_INBOUND_OWNER_ID,
): boolean {
  const database = initDb();
  const claim = database.transaction(() => {
    database
      .prepare("DELETE FROM telegram_inbound_receipts WHERE state = 'completed' AND completed_at < ?")
      .run(now - windowMs);
    const existing = database.prepare(`
      SELECT state, owner_id, owner_pid, claimed_at, completed_at
      FROM telegram_inbound_receipts
      WHERE dedupe_key = ?
    `).get(dedupeKey) as TelegramInboundReceiptRow | undefined;

    if (existing) {
      const existingClaim = claimExistingReceipt(database, existing, dedupeKey, { now, windowMs, ownerId });
      if (existingClaim !== undefined) return existingClaim;
    }

    return database.prepare(`
      INSERT INTO telegram_inbound_receipts (
        dedupe_key, state, owner_id, owner_pid, claimed_at, completed_at
      ) VALUES (?, 'in_flight', ?, ?, ?, NULL)
    `).run(dedupeKey, ownerId, TELEGRAM_INBOUND_OWNER_PID, now).changes === 1;
  });
  return claim();
}

function claimExistingReceipt(
  database: ReturnType<typeof initDb>,
  existing: TelegramInboundReceiptRow,
  dedupeKey: string,
  options: { now: number; windowMs: number; ownerId: string },
): boolean | undefined {
  const { now, windowMs, ownerId } = options;
  if (existing.state === "completed") {
    if (existing.completed_at !== null && existing.completed_at >= now - windowMs) return false;
    database.prepare("DELETE FROM telegram_inbound_receipts WHERE dedupe_key = ?").run(dedupeKey);
    return undefined;
  }

  const stale = existing.claimed_at < now - TELEGRAM_INBOUND_IN_FLIGHT_MAX_MS;
  const sameProcessGeneration = existing.owner_id === ownerId;
  const pidReusedByThisProcess = existing.owner_pid === TELEGRAM_INBOUND_OWNER_PID;
  if (!stale && (sameProcessGeneration || (!pidReusedByThisProcess && ownerProcessIsAlive(existing.owner_pid)))) return false;
  const reclaimed = database.prepare(`
    UPDATE telegram_inbound_receipts
    SET owner_id = ?, owner_pid = ?, claimed_at = ?, completed_at = NULL
    WHERE dedupe_key = ? AND state = 'in_flight' AND owner_id = ?
  `).run(ownerId, TELEGRAM_INBOUND_OWNER_PID, now, dedupeKey, existing.owner_id);
  return reclaimed.changes === 1;
}

/** Release a claim when preprocessing or routing failed before dispatch. */
export function releaseTelegramInbound(
  dedupeKey: string,
  ownerId = TELEGRAM_INBOUND_OWNER_ID,
): boolean {
  return initDb().prepare(`
    DELETE FROM telegram_inbound_receipts
    WHERE dedupe_key = ? AND state = 'in_flight' AND owner_id = ?
  `).run(dedupeKey, ownerId).changes === 1;
}

/** Complete a claim only after the connector handed the message to routing. */
export function completeTelegramInbound(
  dedupeKey: string,
  now = Date.now(),
  ownerId = TELEGRAM_INBOUND_OWNER_ID,
): boolean {
  return initDb().prepare(`
    UPDATE telegram_inbound_receipts
    SET state = 'completed', completed_at = ?
    WHERE dedupe_key = ? AND state = 'in_flight' AND owner_id = ?
  `).run(now, dedupeKey, ownerId).changes === 1;
}

function ownerProcessIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
