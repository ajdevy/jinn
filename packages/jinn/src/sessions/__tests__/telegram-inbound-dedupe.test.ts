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
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_telegram_inbound_receipts_received_at'").get())
      .toEqual({ name: "idx_telegram_inbound_receipts_received_at" });
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

    dbModule.__closeDbForTest();

    expect(dedupe.claimTelegramInbound(key, 1_001)).toBe(false);
    expect(dbModule.initDb().prepare("SELECT COUNT(*) AS count FROM telegram_inbound_receipts").get())
      .toEqual({ count: 1 });
  });

  it("allows the same identity again only after the short window expires", () => {
    const key = dedupe.telegramInboundDedupeKey(999, 12345, 42);
    expect(dedupe.claimTelegramInbound(key, 1_000, 5_000)).toBe(true);
    expect(dedupe.claimTelegramInbound(key, 5_999, 5_000)).toBe(false);
    expect(dedupe.claimTelegramInbound(key, 6_001, 5_000)).toBe(true);
  });

  it("serially collapses a burst to one winner", () => {
    const key = dedupe.telegramInboundDedupeKey(999, 12345, 42);
    const claims = Array.from({ length: 20 }, () => dedupe.claimTelegramInbound(key, 1_000));

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(dbModule.initDb().prepare("SELECT COUNT(*) AS count FROM telegram_inbound_receipts").get())
      .toEqual({ count: 1 });
  });
});
