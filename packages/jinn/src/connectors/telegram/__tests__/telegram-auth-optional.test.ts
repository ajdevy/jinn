import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

const mockGetMe = vi.fn().mockResolvedValue({ id: 999, username: "test_bot" });
const mockStartPolling = vi.fn();
const mockStopPolling = vi.fn().mockResolvedValue(undefined);
const mockOn = vi.fn();
const mockDebug = vi.fn();

vi.mock("node-telegram-bot-api", () => {
  const MockBot = vi.fn(function (this: any) {
    this.sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
    this.getMe = mockGetMe;
    this.startPolling = mockStartPolling;
    this.stopPolling = mockStopPolling;
    this.on = mockOn;
  });
  return { default: MockBot };
});

vi.mock("../../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: mockDebug, error: vi.fn() },
}));

const { TelegramConnector } = await import("../index.js");

describe("TelegramConnector optional Telegram auth", () => {
  it("leaves absent and disabled auth byte-identical at runtime", async () => {
    const readFile = vi.spyOn(fs, "readFileSync");
    const handler = vi.fn();

    for (const telegramAuth of [undefined, { enabled: false, ownerUserIds: [67890] }]) {
      const connector = new TelegramConnector({ botToken: "123456:ABC-DEF", telegramAuth });
      connector.onMessage(handler);
      await connector.start();
      const listener = mockOn.mock.calls.at(-1)?.[1] as (message: unknown) => Promise<void>;
      await listener({
        message_id: 42,
        chat: { id: 12345, type: "private" },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth status",
      });
    }

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls.map(([message]) => message.text)).toEqual([
      "/auth status",
      "/auth status",
    ]);
    expect(readFile.mock.calls.some(([path]) => String(path).includes("telegram-auth"))).toBe(false);
    expect(mockOn).toHaveBeenCalledTimes(2);
  });

  it("keeps the no-handler early return ahead of allowFrom when auth is disabled", async () => {
    mockDebug.mockClear();
    const connector = new TelegramConnector({ botToken: "123456:ABC-DEF", allowFrom: [67890] });
    await connector.start();
    const listener = mockOn.mock.calls.at(-1)?.[1] as (message: unknown) => Promise<void>;

    await listener({
      message_id: 43,
      chat: { id: 12345, type: "private" },
      from: { id: 99999, username: "stranger", first_name: "Stranger", is_bot: false },
      date: Math.floor(Date.now() / 1000) + 10,
      text: "Hello",
    });

    expect(mockDebug).toHaveBeenCalledWith("[telegram] No handler registered, dropping message");
    expect(mockDebug).not.toHaveBeenCalledWith(expect.stringContaining("unauthorized user"));
  });
});
