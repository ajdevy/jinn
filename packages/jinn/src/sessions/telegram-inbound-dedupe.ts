import { initDb } from "../shared/db.js";

/** Keep replay protection short-lived; this is not a permanent Telegram archive. */
export const TELEGRAM_INBOUND_DEDUPE_WINDOW_MS = 5 * 60_000;

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
): boolean {
  const database = initDb();
  const claim = database.transaction(() => {
    database
      .prepare("DELETE FROM telegram_inbound_receipts WHERE received_at < ?")
      .run(now - windowMs);
    return database
      .prepare("INSERT OR IGNORE INTO telegram_inbound_receipts (dedupe_key, received_at) VALUES (?, ?)")
      .run(dedupeKey, now)
      .changes === 1;
  });
  return claim();
}
