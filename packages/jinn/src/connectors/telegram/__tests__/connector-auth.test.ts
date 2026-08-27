import { describe, expect, it, vi, beforeEach } from "vitest";

const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
const mockGetMe = vi.fn().mockResolvedValue({ id: 999, username: "test_bot" });
const mockStartPolling = vi.fn();
const mockOn = vi.fn();
const mockSpawnPty = vi.hoisted(() => vi.fn());

vi.mock("node-telegram-bot-api", () => {
  const MockBot = vi.fn(function (this: any) {
    this.sendMessage = mockSendMessage;
    this.getMe = mockGetMe;
    this.startPolling = mockStartPolling;
    this.on = mockOn;
  });
  return { default: MockBot };
});

vi.mock("node-pty", () => ({ spawn: mockSpawnPty }));
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

  it("sends OAuth discovery URLs without Telegram Markdown parsing", async () => {
    const dataHandlers: Array<(data: string) => void> = [];
    mockSpawnPty.mockReturnValue({
      write: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn((handler: (data: string) => void) => {
        dataHandlers.push(handler);
      }),
      onExit: vi.fn(),
    });
    const telegram = connector();
    await telegram.start();
    const messageHandler = mockOn.mock.calls.find(
      (call) => call[0] === "message",
    )?.[1] as ((message: unknown) => Promise<void>) | undefined;
    expect(messageHandler).toBeDefined();

    await messageHandler?.({
      message_id: 42,
      chat: { id: 12345, type: "private" },
      from: { id: 67890, is_bot: false },
      date: Math.floor(Date.now() / 1000) + 10,
      text: "/auth_claude",
    });

    const url =
      "https://claude.ai/oauth/authorize?client_id=client123&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&code_challenge=challenge123&state=state123";
    dataHandlers[0](url);

    await vi.waitFor(() =>
      expect(mockSendMessage).toHaveBeenCalledWith(
        "12345",
        expect.stringContaining(url),
      ),
    );
  });
});
