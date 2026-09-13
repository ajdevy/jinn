import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage } from "../../../shared/types.js";

const mockGetMe = vi.fn().mockResolvedValue({ id: 999, username: "test_bot" });
const mockStartPolling = vi.fn();
const mockStopPolling = vi.fn().mockResolvedValue(undefined);
const mockOn = vi.fn();
const mockClaimTelegramInbound = vi.fn().mockReturnValue(true);
const mockCompleteTelegramInbound = vi.fn().mockReturnValue(true);
const mockReleaseTelegramInbound = vi.fn().mockReturnValue(true);

vi.mock("node-telegram-bot-api", () => {
  const MockBot = vi.fn(function (this: any) {
    this.getMe = mockGetMe;
    this.startPolling = mockStartPolling;
    this.stopPolling = mockStopPolling;
    this.on = mockOn;
  });
  return { default: MockBot };
});

vi.mock("../../../shared/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../../sessions/telegram-inbound-dedupe.js", () => ({
  claimTelegramInbound: mockClaimTelegramInbound,
  completeTelegramInbound: mockCompleteTelegramInbound,
  releaseTelegramInbound: mockReleaseTelegramInbound,
  telegramInboundDedupeKey: (botId: number, chatId: number, messageId: number) =>
    `telegram:${botId}:${chatId}:${messageId}`,
}));

const { TelegramConnector } = await import("../index.js");

describe("TelegramConnector forward context", () => {
  let connector: InstanceType<typeof TelegramConnector>;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new TelegramConnector({ botToken: "123456:ABC-DEF" });
  });

  it("routes Bot API forward_origin context with author and content", async () => {
    const handler = vi.fn();
    connector.onMessage(handler);
    await connector.start();

    const callback = mockOn.mock.calls.find((call) => call[0] === "message")?.[1];
    await callback({
      message_id: 50,
      chat: { id: 12345, type: "private" as const },
      from: { id: 67890, username: "testuser", is_bot: false },
      date: Math.floor(Date.now() / 1000) + 10,
      text: "Forwarded text",
      forward_origin: {
        type: "user",
        date: 1700000000,
        sender_user: { id: 777, username: "original_author" },
      },
    });

    const msg: IncomingMessage = handler.mock.calls[0][0];
    expect(msg.text).toContain("<telegram-forward-context>");
    expect(msg.text).toContain("forward_type: user");
    expect(msg.text).toContain("author: @original_author");
    expect(msg.text).toContain("forwarded_text:\nForwarded text");
    expect(msg.text.indexOf("<telegram-forward-context>")).toBeLessThan(
      msg.text.indexOf("<telegram-user-message>"),
    );
  });

  it("routes legacy forward fields when forward_origin is absent", async () => {
    const handler = vi.fn();
    connector.onMessage(handler);
    await connector.start();

    const callback = mockOn.mock.calls.find((call) => call[0] === "message")?.[1];
    await callback({
      message_id: 51,
      chat: { id: 12345, type: "private" as const },
      from: { id: 67890, username: "testuser", is_bot: false },
      date: Math.floor(Date.now() / 1000) + 10,
      caption: "Legacy forwarded caption",
      forward_from: { id: 778, username: "legacy_author" },
      forward_sender_name: "Legacy hidden name",
      forward_date: 1700000001,
      document: { file_id: "document-1" },
    });

    const msg: IncomingMessage = handler.mock.calls[0][0];
    expect(msg.text).toContain("<telegram-forward-context>");
    expect(msg.text).toContain("forward_type: legacy");
    expect(msg.text).toContain("author: @legacy_author");
    expect(msg.text).toContain("forwarded_text:\nLegacy forwarded caption");
    expect(msg.text).toContain("forwarded_media: document");
    expect(msg.text).toContain("content_type: document");
  });

  it.each([
    ["absent", {}],
    ["malformed", { forward_origin: "not-an-origin", forward_from: { id: "bad" } }],
  ])("keeps %s forward context safe", async (_label, forwardFields) => {
    const handler = vi.fn();
    connector.onMessage(handler);
    await connector.start();

    const callback = mockOn.mock.calls.find((call) => call[0] === "message")?.[1];
    await expect(callback({
      message_id: 52,
      chat: { id: 12345, type: "private" as const },
      from: { id: 67890, username: "testuser", is_bot: false },
      date: Math.floor(Date.now() / 1000) + 10,
      text: "Safe current text",
      ...forwardFields,
    })).resolves.toBeUndefined();

    const msg: IncomingMessage = handler.mock.calls[0][0];
    expect(msg.text).toBe("Safe current text");
    expect(msg.text).not.toContain("<telegram-forward-context>");
  });
});
