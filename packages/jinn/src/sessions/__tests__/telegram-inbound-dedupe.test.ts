import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { migrateTelegramInboundReceiptsSchema } from "../migrate.js";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-telegram-inbound-dedupe-"));
process.env.JINN_HOME = testHome;

const dbModule = await import("../../shared/db.js");
const dedupe = await import("../telegram-inbound-dedupe.js");

beforeAll(() => {
  dbModule.initDb();
});

beforeEach(() => {
  dbModule.initDb().exec("DELETE FROM telegram_inbound_receipts");
});

describe("migrateTelegramInboundReceiptsSchema", () => {
  it("adds the receipt table and index without disturbing existing rows", () => {
    const database = new Database(":memory:");
    database.exec("CREATE TABLE marker (value TEXT NOT NULL)");
    database.prepare("INSERT INTO marker (value) VALUES (?)").run("keep");

    migrateTelegramInboundReceiptsSchema(database);
    migrateTelegramInboundReceiptsSchema(database);

    expect(database.prepare("SELECT value FROM marker").get()).toEqual({ value: "keep" });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'telegram_inbound_receipts'").get())
      .toEqual({ name: "telegram_inbound_receipts" });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_telegram_inbound_receipts_completed_at'").get())
      .toEqual({ name: "idx_telegram_inbound_receipts_completed_at" });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_telegram_inbound_receipts_claimed_at'").get())
      .toEqual({ name: "idx_telegram_inbound_receipts_claimed_at" });
    database.close();
  });

  it("upgrades the first receipt shape as completed without losing its timestamps", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE telegram_inbound_receipts (
        dedupe_key TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL
      )
    `);
    database.prepare("INSERT INTO telegram_inbound_receipts (dedupe_key, received_at) VALUES (?, ?)")
      .run("telegram:999:12345:42", 1_000);

    migrateTelegramInboundReceiptsSchema(database);

    expect(database.prepare("SELECT state, claimed_at, completed_at FROM telegram_inbound_receipts").get())
      .toEqual({ state: "completed", claimed_at: 1_000, completed_at: 1_000 });
    database.close();
  });
});

describe("Telegram inbound receipt claims", () => {
  it("uses bot id, chat id, and message id as a stable identity", () => {
    expect(dedupe.telegramInboundDedupeKey(999, 12345, 42)).toBe("telegram:999:12345:42");
    expect(dedupe.telegramInboundDedupeKey(1000, 12345, 42)).not.toBe(dedupe.telegramInboundDedupeKey(999, 12345, 42));
    expect(dedupe.telegramInboundDedupeKey(999, 54321, 42)).not.toBe(dedupe.telegramInboundDedupeKey(999, 12345, 42));
    expect(dedupe.telegramInboundDedupeKey(999, 12345, 43)).not.toBe(dedupe.telegramInboundDedupeKey(999, 12345, 42));
  });

  it("claims a message once and rejects a replay across a database reopen", () => {
    const key = dedupe.telegramInboundDedupeKey(999, 12345, 42);
    expect(dedupe.claimTelegramInbound(key, 1_000)).toBe(true);
    expect(dedupe.completeTelegramInbound(key, 1_000)).toBe(true);

    dbModule.__closeDbForTest();

    expect(dedupe.claimTelegramInbound(key, 1_001)).toBe(false);
    expect(dbModule.initDb().prepare("SELECT COUNT(*) AS count FROM telegram_inbound_receipts").get())
      .toEqual({ count: 1 });
  });

  it("allows the same identity again only after the bounded window expires", () => {
    const key = dedupe.telegramInboundDedupeKey(999, 12345, 42);
    expect(dedupe.claimTelegramInbound(key, 1_000)).toBe(true);
    expect(dedupe.completeTelegramInbound(key, 1_000)).toBe(true);
    expect(dedupe.claimTelegramInbound(key, 1_000 + dedupe.TELEGRAM_INBOUND_DEDUPE_WINDOW_MS - 1)).toBe(false);
    expect(dedupe.claimTelegramInbound(key, 1_000 + dedupe.TELEGRAM_INBOUND_DEDUPE_WINDOW_MS + 1)).toBe(true);
  });

  it("reclaims an in-flight receipt left by a dead process", () => {
    const key = dedupe.telegramInboundDedupeKey(999, 12345, 42);
    dbModule.initDb().prepare(`
      INSERT INTO telegram_inbound_receipts (
        dedupe_key, state, owner_id, owner_pid, claimed_at, completed_at
      ) VALUES (?, 'in_flight', 'dead-owner', 0, ?, NULL)
    `).run(key, 1_000);

    expect(dedupe.claimTelegramInbound(key, 1_001)).toBe(true);
  });

  it("reclaims a stale receipt even when the original owner still has this PID", () => {
    const key = dedupe.telegramInboundDedupeKey(999, 12345, 42);
    const claimedAt = 1_000;
    dbModule.initDb().prepare(`
      INSERT INTO telegram_inbound_receipts (
        dedupe_key, state, owner_id, owner_pid, claimed_at, completed_at
      ) VALUES (?, 'in_flight', 'current-owner', ?, ?, NULL)
    `).run(key, process.pid, claimedAt);

    expect(dedupe.claimTelegramInbound(
      key,
      claimedAt + dedupe.TELEGRAM_INBOUND_IN_FLIGHT_MAX_MS + 1,
    )).toBe(true);
  });

  it("sweeps stale in-flight receipts when another message is claimed", () => {
    const staleKey = dedupe.telegramInboundDedupeKey(999, 12345, 42);
    const freshKey = dedupe.telegramInboundDedupeKey(999, 12345, 43);
    const now = 1_000 + dedupe.TELEGRAM_INBOUND_IN_FLIGHT_MAX_MS + 1;
    dbModule.initDb().prepare(`
      INSERT INTO telegram_inbound_receipts (
        dedupe_key, state, owner_id, owner_pid, claimed_at, completed_at
      ) VALUES (?, 'in_flight', 'dead-owner', 0, ?, NULL)
    `).run(staleKey, 1_000);

    expect(dedupe.claimTelegramInbound(freshKey, now)).toBe(true);
    expect(dbModule.initDb().prepare("SELECT COUNT(*) AS count FROM telegram_inbound_receipts WHERE dedupe_key = ?").get(staleKey))
      .toEqual({ count: 0 });
  });

  it("does not let another owner release or complete the active receipt", () => {
    const key = dedupe.telegramInboundDedupeKey(999, 12345, 42);
    dbModule.initDb().prepare(`
      INSERT INTO telegram_inbound_receipts (
        dedupe_key, state, owner_id, owner_pid, claimed_at, completed_at
      ) VALUES (?, 'in_flight', 'owner-a', ?, ?, NULL)
    `).run(key, process.pid, 1_000);

    expect(dedupe.releaseTelegramInbound(key, "owner-b")).toBe(false);
    expect(dedupe.completeTelegramInbound(key, 1_001, "owner-b")).toBe(false);
    expect(dbModule.initDb().prepare("SELECT state, owner_id FROM telegram_inbound_receipts WHERE dedupe_key = ?").get(key))
      .toEqual({ state: "in_flight", owner_id: "owner-a" });
  });

  it("does not sweep an old in-flight receipt owned by this process", () => {
    const activeKey = dedupe.telegramInboundDedupeKey(999, 12345, 42);
    const otherKey = dedupe.telegramInboundDedupeKey(999, 12345, 43);
    const now = 1_000 + dedupe.TELEGRAM_INBOUND_IN_FLIGHT_MAX_MS + 1;
    expect(dedupe.claimTelegramInbound(activeKey, 1_000)).toBe(true);
    expect(dedupe.claimTelegramInbound(otherKey, now)).toBe(true);

    expect(dbModule.initDb().prepare("SELECT COUNT(*) AS count FROM telegram_inbound_receipts WHERE dedupe_key = ?").get(activeKey))
      .toEqual({ count: 1 });
    expect(dedupe.claimTelegramInbound(activeKey, now)).toBe(false);
  });

  it("serially collapses a burst to one winner", () => {
    const key = dedupe.telegramInboundDedupeKey(999, 12345, 42);
    const claims = Array.from({ length: 20 }, () => dedupe.claimTelegramInbound(key, 1_000));

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(dbModule.initDb().prepare("SELECT COUNT(*) AS count FROM telegram_inbound_receipts").get())
      .toEqual({ count: 1 });
  });
});
