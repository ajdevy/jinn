import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, Session, Target } from "../../../shared/types.js";

// Mock node-telegram-bot-api before importing connector
const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
const mockEditMessageText = vi.fn().mockResolvedValue(true);
const mockDeleteMessage = vi.fn().mockResolvedValue(true);
const mockGetMe = vi.fn().mockResolvedValue({ id: 999, username: "test_bot" });
const mockStartPolling = vi.fn();
const mockStopPolling = vi.fn().mockResolvedValue(undefined);
const mockOn = vi.fn();
const mockPtyWrite = vi.fn();
const mockPtyKill = vi.fn();
const mockPtyOnData = vi.fn();
const mockPtyOnExit = vi.fn();
const mockPtySpawn = vi.fn(() => ({
  write: mockPtyWrite,
  kill: mockPtyKill,
  onData: mockPtyOnData,
  onExit: mockPtyOnExit,
}));
let mockClaudeLoggedIn = false;
let mockCodexExitCode = 1;
let mockCodexHang = false;
const mockExecFile = vi.fn((_file, _args, _options, callback) => {
  callback(null, JSON.stringify({ loggedIn: mockClaudeLoggedIn }));
});
const mockChildKill = vi.fn();
const mockSpawnRemoveListener = vi.fn();
const mockSpawnOnce = vi.fn(function (this: any, event: string, handler: (code?: number) => void) {
  if (event === "exit" && !mockCodexHang) {
    queueMicrotask(() => handler(mockCodexExitCode));
  }
  return this;
});
const mockSpawn = vi.fn(() => ({
  kill: mockChildKill,
  once: mockSpawnOnce,
  removeListener: mockSpawnRemoveListener,
}));

vi.mock("node-telegram-bot-api", () => {
  const MockBot = vi.fn(function (this: any) {
    this.sendMessage = mockSendMessage;
    this.editMessageText = mockEditMessageText;
    this.deleteMessage = mockDeleteMessage;
    this.getMe = mockGetMe;
    this.startPolling = mockStartPolling;
    this.stopPolling = mockStopPolling;
    this.on = mockOn;
  });
  return { default: MockBot };
});

vi.mock("node-pty", () => ({
  spawn: mockPtySpawn,
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
  spawn: mockSpawn,
}));

vi.mock("../../../shared/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocks are set up
const { TelegramConnector } = await import("../index.js");
const { deliverConnectorReply } = await import("../../../gateway/api.js");

describe("TelegramConnector", () => {
  let connector: InstanceType<typeof TelegramConnector>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClaudeLoggedIn = false;
    mockCodexExitCode = 1;
    mockCodexHang = false;
    connector = new TelegramConnector({
      botToken: "123456:ABC-DEF",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("constructor", () => {
    it("sets the connector name to telegram", () => {
      expect(connector.name).toBe("telegram");
    });
  });

  describe("getCapabilities", () => {
    it("returns correct capabilities", () => {
      expect(connector.getCapabilities()).toEqual({
        threading: false,
        messageEdits: true,
        reactions: false,
        attachments: true,
      });
    });
  });

  describe("getHealth", () => {
    it("returns stopped before start", () => {
      const health = connector.getHealth();
      expect(health.status).toBe("stopped");
    });
  });

  describe("start", () => {
    it("registers message handler and starts polling after validation", async () => {
      await connector.start();
      const health = connector.getHealth();
      expect(health.status).toBe("running");
      expect(mockGetMe).toHaveBeenCalledOnce();
      expect(mockStartPolling).toHaveBeenCalledOnce();
      expect(mockOn).toHaveBeenCalledWith("message", expect.any(Function));
    });

    it("does not start polling if getMe fails (invalid token)", async () => {
      mockGetMe.mockRejectedValueOnce(new Error("Invalid token"));
      await connector.start();
      const health = connector.getHealth();
      expect(health.status).toBe("error");
      expect(health.detail).toContain("Invalid token");
      expect(mockStartPolling).not.toHaveBeenCalled();
    });
  });

  describe("stop", () => {
    it("stops polling and sets stopped state", async () => {
      await connector.start();
      await connector.stop();
      expect(mockStopPolling).toHaveBeenCalledOnce();
      expect(connector.getHealth().status).toBe("stopped");
    });
  });

  describe("onMessage", () => {
    it("preserves default-disabled auth text routing", async () => {
      const handler = vi.fn();
      connector.onMessage(handler);
      await connector.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 42,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "testuser", first_name: "Test", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth status",
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].text).toBe("/auth status");
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockPtySpawn).not.toHaveBeenCalled();
    });

    it("handles owner auth status without a normal handler", async () => {
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: {
          enabled: true,
          ownerUserIds: [67890],
        },
      });
      await authConnector.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 42,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth status",
      });

      expect(mockSendMessage).toHaveBeenCalledWith(
        "12345",
        [
          "Claude is not authenticated. Use /auth claude to sign in.",
          "Codex is not authenticated. Use /auth codex to sign in.",
        ].join("\n"),
        { parse_mode: "Markdown" },
      );
      expect(mockPtySpawn).not.toHaveBeenCalled();
    });

    it("reports authenticated provider status without CLI output", async () => {
      mockClaudeLoggedIn = true;
      mockCodexExitCode = 0;
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: {
          enabled: true,
          ownerUserIds: [67890],
        },
      });
      const handler = vi.fn();
      authConnector.onMessage(handler);
      await authConnector.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 42,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth status",
      });

      expect(handler).not.toHaveBeenCalled();
      expect(mockSendMessage).toHaveBeenCalledWith(
        "12345",
        ["Claude is authenticated.", "Codex is authenticated."].join("\n"),
        { parse_mode: "Markdown" },
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        "claude",
        ["auth", "status", "--json"],
        expect.objectContaining({
          env: expect.objectContaining({
            HOME: "/home/node",
            CLAUDE_CONFIG_DIR: "/home/node/.claude",
            CODEX_HOME: "/home/node/.codex",
          }),
        }),
        expect.any(Function),
      );
      expect(mockSpawn).toHaveBeenCalledWith(
        "codex",
        ["login", "status"],
        expect.objectContaining({
          env: expect.objectContaining({
            HOME: "/home/node",
            CLAUDE_CONFIG_DIR: "/home/node/.claude",
            CODEX_HOME: "/home/node/.codex",
          }),
          stdio: "ignore",
        }),
      );
    });

    it("terminates timed-out Codex status and escalates to SIGKILL", async () => {
      vi.useFakeTimers();
      mockClaudeLoggedIn = true;
      mockCodexHang = true;
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: {
          enabled: true,
          ownerUserIds: [67890],
        },
      });
      await authConnector.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      const statusPromise = messageCallback({
        message_id: 42,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth status",
      });

      await vi.advanceTimersByTimeAsync(15_000);
      expect(mockChildKill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mockChildKill).toHaveBeenCalledWith("SIGKILL");
      await vi.advanceTimersByTimeAsync(2_000);
      await statusPromise;

      expect(mockSpawnRemoveListener).toHaveBeenCalledWith("error", expect.any(Function));
      expect(mockSpawnRemoveListener).toHaveBeenCalledWith("exit", expect.any(Function));
      expect(mockSpawnRemoveListener).toHaveBeenCalledWith("close", expect.any(Function));
      expect(mockSendMessage).toHaveBeenCalledWith(
        "12345",
        [
          "Claude is authenticated.",
          "Codex is not authenticated. Use /auth codex to sign in.",
        ].join("\n"),
        { parse_mode: "Markdown" },
      );
    });

    it("starts owner auth without calling the normal handler", async () => {
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: {
          enabled: true,
          ownerUserIds: [67890],
        },
      });
      const handler = vi.fn();
      authConnector.onMessage(handler);
      await authConnector.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 43,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth claude",
      });

      expect(handler).not.toHaveBeenCalled();
      expect(mockPtySpawn).toHaveBeenCalledWith(
        "claude",
        ["auth", "login", "--claudeai"],
        expect.objectContaining({
          cwd: "/home/node",
          env: expect.objectContaining({
            HOME: "/home/node",
            CLAUDE_CONFIG_DIR: "/home/node/.claude",
            CODEX_HOME: "/home/node/.codex",
          }),
        }),
      );
    });

    it("deletes owner auth input best-effort without calling the normal handler", async () => {
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: {
          enabled: true,
          ownerUserIds: [67890],
        },
      });
      const handler = vi.fn();
      authConnector.onMessage(handler);
      await authConnector.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 44,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth input AB12-CD34",
      });

      expect(handler).not.toHaveBeenCalled();
      expect(mockDeleteMessage).toHaveBeenCalledWith("12345", 44);
    });

    it("ignores non-owner auth text after allowFrom without normal routing", async () => {
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890, 99999],
        telegramAuth: {
          enabled: true,
          ownerUserIds: [67890],
        },
      });
      const handler = vi.fn();
      authConnector.onMessage(handler);
      await authConnector.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 45,
        chat: { id: 12345, type: "private" as const },
        from: { id: 99999, username: "stranger", first_name: "Stranger", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth status",
      });

      expect(handler).not.toHaveBeenCalled();
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockPtySpawn).not.toHaveBeenCalled();
    });

    it("rejects owner auth commands in groups without normal routing", async () => {
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: {
          enabled: true,
          ownerUserIds: [67890],
        },
      });
      const handler = vi.fn();
      authConnector.onMessage(handler);
      await authConnector.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 46,
        chat: { id: -10012345, type: "group" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth status",
      });

      expect(handler).not.toHaveBeenCalled();
      expect(mockSendMessage).toHaveBeenCalledWith(
        "-10012345",
        "Authentication commands are available only in a private chat.",
        { parse_mode: "Markdown" },
      );
    });

    it("routes ordinary owner messages unchanged when auth is enabled", async () => {
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: {
          enabled: true,
          ownerUserIds: [67890],
        },
      });
      const handler = vi.fn();
      authConnector.onMessage(handler);
      await authConnector.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 47,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "Hello bot!",
      });

      expect(handler).toHaveBeenCalledOnce();
      const msg: IncomingMessage = handler.mock.calls[0][0];
      expect(msg.text).toBe("Hello bot!");
      expect(msg.userId).toBe("67890");
      expect(msg.channel).toBe("12345");
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("stamps and replies through a named connector instance id", async () => {
      const named = new TelegramConnector({
        id: "telegram-support",
        botToken: "123456:ABC-DEF",
      });
      const handler = vi.fn();
      named.onMessage(handler);
      await named.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 42,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "testuser", first_name: "Test", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "Hello named bot!",
      });

      const incoming: IncomingMessage = handler.mock.calls[0][0];
      expect(incoming.connector).toBe("telegram-support");
      expect(incoming.sessionKey).toBe("telegram-support:12345");

      await deliverConnectorReply({
        id: "session-named",
        source: incoming.source,
        connector: incoming.connector,
        replyContext: incoming.replyContext,
      } as Session, "Named reply", new Map([[named.id, named]]));

      expect(mockSendMessage).toHaveBeenCalledWith("12345", "Named reply", {
        parse_mode: "Markdown",
        reply_parameters: { message_id: 42 },
      });
    });

    it("routes incoming messages to the handler", async () => {
      const handler = vi.fn();
      connector.onMessage(handler);
      await connector.start();

      // Get the registered message callback
      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      expect(messageCallback).toBeDefined();

      // Simulate incoming Telegram message
      const telegramMsg = {
        message_id: 42,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "testuser", first_name: "Test", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "Hello bot!",
      };
      await messageCallback(telegramMsg);

      expect(handler).toHaveBeenCalledOnce();
      const msg: IncomingMessage = handler.mock.calls[0][0];
      expect(msg.connector).toBe("telegram");
      expect(msg.source).toBe("telegram");
      expect(msg.sessionKey).toBe("telegram:12345");
      expect(msg.text).toBe("Hello bot!");
      expect(msg.user).toBe("testuser");
      expect(msg.userId).toBe("67890");
      expect(msg.channel).toBe("12345");
    });

    it("ignores messages from bots", async () => {
      const handler = vi.fn();
      connector.onMessage(handler);
      await connector.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];

      const botMsg = {
        message_id: 1,
        chat: { id: 12345, type: "private" as const },
        from: { id: 999, username: "test_bot", first_name: "Bot", is_bot: true },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "Bot message",
      };
      await messageCallback(botMsg);

      expect(handler).not.toHaveBeenCalled();
    });

    it("ignores messages from unauthorized users when allowFrom is set", async () => {
      const restricted = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
      });
      const handler = vi.fn();
      restricted.onMessage(handler);
      await restricted.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];

      // Unauthorized user
      const msg = {
        message_id: 1,
        chat: { id: 11111, type: "private" as const },
        from: { id: 99999, username: "stranger", first_name: "Stranger", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "Hello",
      };
      await messageCallback(msg);
      expect(handler).not.toHaveBeenCalled();
    });

    it("rejects messages with from: undefined when allowFrom is set", async () => {
      const restricted = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
      });
      const handler = vi.fn();
      restricted.onMessage(handler);
      await restricted.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];

      // Channel post or forwarded message with no `from`
      const msg = {
        message_id: 1,
        chat: { id: 11111, type: "channel" as const },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "Channel post",
      };
      await messageCallback(msg);
      expect(handler).not.toHaveBeenCalled();
    });

    it("allows messages from authorized users through allowFrom", async () => {
      const restricted = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
      });
      const handler = vi.fn();
      restricted.onMessage(handler);
      await restricted.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];

      const msg = {
        message_id: 1,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "allowed_user", first_name: "Allowed", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "Hello",
      };
      await messageCallback(msg);
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe("sendMessage", () => {
    const target: Target = { channel: "12345" };

    it("sends a message to the target chat", async () => {
      await connector.sendMessage(target, "Hello!");
      expect(mockSendMessage).toHaveBeenCalledWith("12345", "Hello!", { parse_mode: "Markdown" });
    });

    it("does not send empty messages", async () => {
      await connector.sendMessage(target, "");
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("chunks long messages", async () => {
      await connector.sendMessage(target, "A".repeat(5000));
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });

    it("retries without parse_mode on Markdown parse error", async () => {
      mockSendMessage
        .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
        .mockResolvedValueOnce({ message_id: 2 });
      const result = await connector.sendMessage(target, "**bad markdown");
      // First call with Markdown, second without
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      expect(mockSendMessage.mock.calls[0][2]).toEqual({ parse_mode: "Markdown" });
      expect(mockSendMessage.mock.calls[1][2]).toEqual({});
      expect(result).toBe("2");
    });

    it("rejects when the plain-text retry also fails", async () => {
      mockSendMessage.mockRejectedValueOnce(new Error("can't parse entities")).mockRejectedValueOnce(new Error("chat not found"));
      await expect(connector.sendMessage(target, "**bad markdown")).rejects.toThrow("chat not found");
    });
  });

  describe("authentication failures", () => {
    it("offers the owner login commands after a provider authentication failure", async () => {
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: {
          enabled: true,
          ownerUserIds: [67890],
        },
      });

      await authConnector.replyMessage(
        { channel: "12345", replyContext: { chatId: "12345", messageId: 42 } },
        "⛔ Interactive turn failed: authentication_failed",
      );

      expect(mockSendMessage).toHaveBeenCalledWith(
        "12345",
        expect.stringContaining("use /auth claude or /auth codex to sign in."),
        expect.objectContaining({
          parse_mode: "Markdown",
          reply_parameters: { message_id: 42 },
        }),
      );
    });

    it("does not add login prompts to unrelated provider errors", async () => {
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: {
          enabled: true,
          ownerUserIds: [67890],
        },
      });

      await authConnector.replyMessage(
        { channel: "12345", replyContext: { chatId: "12345", messageId: 42 } },
        "⛔ Interactive turn failed: rate_limit",
      );

      expect(mockSendMessage).toHaveBeenCalledWith(
        "12345",
        "⛔ Interactive turn failed: rate_limit",
        {
          parse_mode: "Markdown",
          reply_parameters: { message_id: 42 },
        },
      );
    });
  });

  describe("replyMessage", () => {
    it("sends a reply to a specific message", async () => {
      const target: Target = {
        channel: "12345",
        replyContext: { chatId: 12345, messageId: 42 },
      };
      await connector.replyMessage(target, "Reply!");
      expect(mockSendMessage).toHaveBeenCalledWith("12345", "Reply!", {
        parse_mode: "Markdown",
        reply_parameters: { message_id: 42 },
      });
    });
  });

  describe("editMessage", () => {
    it("edits an existing message", async () => {
      const target: Target = {
        channel: "12345",
        messageTs: "42",
      };
      await connector.editMessage(target, "Edited!");
      expect(mockEditMessageText).toHaveBeenCalledWith("Edited!", {
        chat_id: "12345",
        message_id: 42,
        parse_mode: "Markdown",
      });
    });
  });

  describe("reconstructTarget", () => {
    it("reconstructs target from reply context", () => {
      const target = connector.reconstructTarget({
        chatId: 12345,
        messageId: 42,
      });
      expect(target.channel).toBe("12345");
      expect(target.messageTs).toBe("42");
      expect(target.replyContext).toEqual({ chatId: 12345, messageId: 42 });
    });
  });
});
