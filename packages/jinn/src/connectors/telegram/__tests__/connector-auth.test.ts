import { describe, expect, it, vi, beforeEach } from "vitest";

const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 1 });

vi.mock("node-telegram-bot-api", () => {
  const MockBot = vi.fn(function (this: any) {
    this.sendMessage = mockSendMessage;
  });
  return { default: MockBot };
});

vi.mock("node-pty", () => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

const { TelegramConnector } = await import("../index.js");

function target(chatType: string, userId: number, channel = "12345") {
  return {
    channel,
    replyContext: {
      chatId: channel,
      messageId: 42,
      chatType,
      userId,
    },
  };
}

function connector(ownerUserIds = [67890], allowFrom = ownerUserIds) {
  return new TelegramConnector({
    botToken: "123456:ABC-DEF",
    allowFrom,
    telegramAuth: { enabled: true, ownerUserIds },
  });
}

describe("TelegramConnector authentication prompts", () => {
  beforeEach(() => mockSendMessage.mockClear());

  it("offers the owner login commands after provider authentication failure", async () => {
    await connector().replyMessage(
      target("private", 67890),
      "⛔ Interactive turn failed: authentication_failed",
    );

    expect(mockSendMessage).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("use /auth_claude or /auth_codex to sign in."),
      expect.objectContaining({
        parse_mode: "Markdown",
        reply_parameters: { message_id: 42 },
      }),
    );
  });

  it("does not add login prompts to unrelated provider errors", async () => {
    await connector().replyMessage(
      target("private", 67890),
      "⛔ unrelated MCP: browser is not logged in",
    );
    expect(mockSendMessage).toHaveBeenCalledWith(
      "12345",
      "⛔ unrelated MCP: browser is not logged in",
      expect.objectContaining({ reply_parameters: { message_id: 42 } }),
    );
  });

  it("does not offer login outside the owner private chat", async () => {
    await connector().replyMessage(
      target("group", 67890, "-100999"),
      "⛔ Interactive turn failed: authentication_failed",
    );
    expect(mockSendMessage).toHaveBeenCalledWith(
      "-100999",
      "⛔ Interactive turn failed: authentication_failed",
      expect.objectContaining({ reply_parameters: { message_id: 42 } }),
    );
  });

  it("does not offer login to a non-owner private chat", async () => {
    await connector([67890], [11111]).replyMessage(
      target("private", 11111),
      "⛔ Interactive turn failed: authentication_failed",
    );
    expect(mockSendMessage).toHaveBeenCalledWith(
      "12345",
      "⛔ Interactive turn failed: authentication_failed",
      expect.objectContaining({ reply_parameters: { message_id: 42 } }),
    );
  });
});
