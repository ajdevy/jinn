import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, Session, Target } from "../../../shared/types.js";
import { JINN_HOME } from "../../../shared/paths.js";

const realExistsSync = fs.existsSync.bind(fs);

// Mock node-telegram-bot-api before importing connector
const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
const mockEditMessageText = vi.fn().mockResolvedValue(true);
const mockDeleteMessage = vi.fn().mockResolvedValue(true);
const mockDeleteMyCommands = vi.fn().mockResolvedValue(true);
const mockGetMe = vi.fn().mockResolvedValue({ id: 999, username: "test_bot" });
const mockGetMyCommands = vi.fn().mockResolvedValue([]);
const mockSetMyCommands = vi.fn().mockResolvedValue(true);
const mockStartPolling = vi.fn();
const mockStopPolling = vi.fn().mockResolvedValue(undefined);
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();
const mockPtyWrite = vi.fn();
const mockPtyKill = vi.fn();
const mockPtyOnData = vi.fn();
const mockPtyOnExit = vi.fn();
const mockExecFile = vi.fn();
const mockPtySpawn = vi.fn(() => ({
  write: mockPtyWrite,
  kill: mockPtyKill,
  onData: mockPtyOnData,
  onExit: mockPtyOnExit,
}));

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

vi.mock("node-telegram-bot-api", () => {
  const MockBot = vi.fn(function (this: any) {
    this.sendMessage = mockSendMessage;
    this.editMessageText = mockEditMessageText;
    this.deleteMessage = mockDeleteMessage;
    this.deleteMyCommands = mockDeleteMyCommands;
    this.getMe = mockGetMe;
    this.getMyCommands = mockGetMyCommands;
    this.setMyCommands = mockSetMyCommands;
    this.startPolling = mockStartPolling;
    this.stopPolling = mockStopPolling;
    this.on = mockOn;
    this.removeListener = mockRemoveListener;
  });
  return { default: MockBot };
});

vi.mock("node-pty", () => ({
  spawn: mockPtySpawn,
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
  spawn: vi.fn(),
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

  function mockClaudeAuthStatus(loggedIn = false): void {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (
        error: Error | null,
        stdout?: string,
        stderr?: string,
      ) => void;
      queueMicrotask(() => callback(null, JSON.stringify({ loggedIn }), ""));
      return { kill: vi.fn() };
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile.mockReset();
    mockClaudeAuthStatus();
    vi.spyOn(fs, "existsSync").mockImplementation((target) =>
      String(target) === "/home/node/.codex/auth.json"
        ? false
        : realExistsSync(target),
    );
    fs.rmSync(path.join(JINN_HOME, "state", "telegram-auth-menu-owners"), {
      recursive: true,
      force: true,
    });
    connector = new TelegramConnector({
      botToken: "123456:ABC-DEF",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    mockSetMyCommands.mockReset().mockResolvedValue(true);
    mockDeleteMyCommands.mockReset().mockResolvedValue(true);
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
      expect(mockSetMyCommands).not.toHaveBeenCalled();
    });

    it("configures the auth command menu only for each owner chat", async () => {
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        telegramAuth: {
          enabled: true,
          ownerUserIds: [67890, 67891],
        },
      });

      await authConnector.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockSetMyCommands).toHaveBeenCalledTimes(2);
      expect(mockSetMyCommands).toHaveBeenNthCalledWith(
        1,
        [
          { command: "auth_claude", description: "Authenticate Claude" },
          { command: "auth_codex", description: "Authenticate Codex" },
          { command: "auth_status", description: "Show authentication status" },
          { command: "auth_cancel", description: "Cancel current authentication" },
        ],
        { scope: { type: "chat", chat_id: 67890 } },
      );
      expect(mockSetMyCommands).toHaveBeenNthCalledWith(
        2,
        expect.any(Array),
        { scope: { type: "chat", chat_id: 67891 } },
      );
    });

    it("publishes owner menus only to users admitted by allowFrom", async () => {
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: {
          enabled: true,
          ownerUserIds: [67890, 67891],
        },
      });

      await authConnector.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockSetMyCommands).toHaveBeenCalledTimes(1);
      expect(mockSetMyCommands).toHaveBeenCalledWith(
        expect.any(Array),
        { scope: { type: "chat", chat_id: 67890 } },
      );
    });

    it("retries an owner menu after the chat-not-found publication failure", async () => {
      mockSetMyCommands
        .mockRejectedValueOnce(new Error("ETELEGRAM: 400 Bad Request: chat not found"))
        .mockResolvedValueOnce(true);
      const authConnector = new TelegramConnector({
        id: "telegram-permanent-current-owner",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });

      await authConnector.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockSetMyCommands).toHaveBeenCalledOnce();
      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 41,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "hello",
      });
      await flushPromises();

      expect(mockSetMyCommands).toHaveBeenCalledTimes(2);
      const stateFiles = fs.readdirSync(
        path.join(JINN_HOME, "state", "telegram-auth-menu-owners"),
      );
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(
              JINN_HOME,
              "state",
              "telegram-auth-menu-owners",
              stateFiles[0],
            ),
            "utf8",
          ),
        ),
      ).toEqual([67890]);
    });

    it("preserves default Telegram commands in the owner-scoped menu", async () => {
      mockGetMyCommands.mockResolvedValueOnce([
        { command: "start", description: "Start" },
      ]);
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });

      await authConnector.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockSetMyCommands).toHaveBeenCalledWith(
        expect.arrayContaining([
          { command: "start", description: "Start" },
          { command: "auth_claude", description: "Authenticate Claude" },
        ]),
        { scope: { type: "chat", chat_id: 67890 } },
      );
    });

    it("retries auth menu configuration after a transient startup failure", async () => {
      mockSetMyCommands.mockRejectedValueOnce(new Error("temporary Telegram failure"));
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: {
          enabled: true,
          ownerUserIds: [67890],
        },
      });

      await authConnector.start();
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockSetMyCommands).toHaveBeenCalledOnce();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 41,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "hello",
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockSetMyCommands).toHaveBeenCalledTimes(2);
    });

    it("converges when a stale owner scope is permanently unreachable", async () => {
      const initial = new TelegramConnector({
        id: "telegram-permanent-stale",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890, 67891] },
      });
      await initial.start();
      await new Promise((resolve) => setImmediate(resolve));
      mockDeleteMyCommands.mockRejectedValueOnce(
        new Error("ETELEGRAM: 400 Bad Request: chat not found"),
      );
      mockSetMyCommands.mockClear();

      const rotated = new TelegramConnector({
        id: "telegram-permanent-stale",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await rotated.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockSetMyCommands).toHaveBeenCalledWith(
        expect.any(Array),
        { scope: { type: "chat", chat_id: 67890 } },
      );
      const stateFiles = fs.readdirSync(path.join(JINN_HOME, "state", "telegram-auth-menu-owners"));
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(JINN_HOME, "state", "telegram-auth-menu-owners", stateFiles[0]),
            "utf8",
          ),
        ),
      ).toEqual([67890]);
    });

    it("retains intent for an owner when setMyCommands acknowledgement is lost", async () => {
      mockSetMyCommands
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error("request timed out after Telegram applied it"));
      const initial = new TelegramConnector({
        id: "telegram-lost-ack",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890, 67891] },
      });
      await initial.start();
      await new Promise((resolve) => setImmediate(resolve));
      mockDeleteMyCommands.mockClear();

      const rotated = new TelegramConnector({
        id: "telegram-lost-ack",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await rotated.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockDeleteMyCommands).toHaveBeenCalledWith({
        scope: { type: "chat", chat_id: 67891 },
      });
    });

    it("retains old and new owners when stale cleanup and publication both fail", async () => {
      const initial = new TelegramConnector({
        id: "telegram-stale-lost-ack",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await initial.start();
      await new Promise((resolve) => setImmediate(resolve));
      mockDeleteMyCommands.mockRejectedValueOnce(new Error("temporary cleanup failure"));
      mockSetMyCommands.mockRejectedValueOnce(new Error("request timed out after apply"));

      const rotated = new TelegramConnector({
        id: "telegram-stale-lost-ack",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67891] },
      });
      await rotated.start();
      await new Promise((resolve) => setImmediate(resolve));

      const stateFiles = fs.readdirSync(path.join(JINN_HOME, "state", "telegram-auth-menu-owners"));
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(JINN_HOME, "state", "telegram-auth-menu-owners", stateFiles[0]),
            "utf8",
          ),
        ),
      ).toEqual([67890, 67891]);
    });

    it("backs off repeated menu failures instead of retrying immediately", async () => {
      vi.useFakeTimers();
      mockSetMyCommands.mockRejectedValue(new Error("temporary Telegram failure"));
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });

      await authConnector.start();
      await vi.runAllTimersAsync();
      await flushPromises();
      expect(mockSetMyCommands).toHaveBeenCalledTimes(1);

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 41,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "hello",
      });
      await vi.runAllTimersAsync();
      await flushPromises();
      expect(mockSetMyCommands).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(59_999);
      await messageCallback({
        message_id: 42,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "hello",
      });
      await vi.runAllTimersAsync();
      await flushPromises();
      expect(mockSetMyCommands).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(1);
      await messageCallback({
        message_id: 43,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "hello",
      });
      await flushPromises();
      expect(mockSetMyCommands).toHaveBeenCalledTimes(3);
    });

    it("reconciles stale owner scopes and persists the current owner set", async () => {
      const initial = new TelegramConnector({
        id: "telegram-rotation",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890, 67891] },
      });
      await initial.start();
      await new Promise((resolve) => setImmediate(resolve));
      mockSetMyCommands.mockClear();
      mockDeleteMyCommands.mockClear();

      const rotated = new TelegramConnector({
        id: "telegram-rotation",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await rotated.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockDeleteMyCommands).toHaveBeenCalledWith({
        scope: { type: "chat", chat_id: 67891 },
      });
      const stateFiles = fs.readdirSync(path.join(JINN_HOME, "state", "telegram-auth-menu-owners"));
      expect(stateFiles).toHaveLength(1);
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(JINN_HOME, "state", "telegram-auth-menu-owners", stateFiles[0]),
            "utf8",
          ),
        ),
      ).toEqual([67890]);
    });

    it("preserves damaged state without inventing stale owner IDs", async () => {
      const initial = new TelegramConnector({
        id: "telegram-damaged-state",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890, 67891] },
      });
      await initial.start();
      await new Promise((resolve) => setImmediate(resolve));
      const stateFiles = fs.readdirSync(path.join(JINN_HOME, "state", "telegram-auth-menu-owners"));
      const statePath = path.join(
        JINN_HOME,
        "state",
        "telegram-auth-menu-owners",
        stateFiles[0],
      );
      fs.writeFileSync(statePath, "[67890, 67891\n", { mode: 0o600 });
      mockDeleteMyCommands.mockClear();

      const rotated = new TelegramConnector({
        id: "telegram-damaged-state",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await rotated.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockDeleteMyCommands).not.toHaveBeenCalled();
      const rotatedStateFiles = fs.readdirSync(
        path.join(JINN_HOME, "state", "telegram-auth-menu-owners"),
      );
      expect(rotatedStateFiles.some((file) => file.includes(".corrupt-"))).toBe(true);
      const currentStateFile = rotatedStateFiles.find(
        (file) => !file.includes(".corrupt-"),
      );
      expect(currentStateFile).toBeDefined();
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(
              JINN_HOME,
              "state",
              "telegram-auth-menu-owners",
              currentStateFile!,
            ),
            "utf8",
          ),
        ),
      ).toEqual([67890]);
    });

    it("keeps the owner ledger intact across a transient state-file read failure", async () => {
      const initial = new TelegramConnector({
        id: "telegram-read-failure",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890, 67891] },
      });
      await initial.start();
      await new Promise((resolve) => setImmediate(resolve));
      mockDeleteMyCommands.mockClear();

      const readFileSpy = vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
      });
      const rotated = new TelegramConnector({
        id: "telegram-read-failure",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });

      await rotated.start();
      await new Promise((resolve) => setImmediate(resolve));
      readFileSpy.mockRestore();

      expect(mockDeleteMyCommands).toHaveBeenCalledWith({
        scope: { type: "chat", chat_id: 67891 },
      });
      const stateFiles = fs.readdirSync(
        path.join(JINN_HOME, "state", "telegram-auth-menu-owners"),
      );
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(
              JINN_HOME,
              "state",
              "telegram-auth-menu-owners",
              stateFiles[0],
            ),
            "utf8",
          ),
        ),
      ).toEqual([67890]);
    });

    it("keeps the previous owner state when stale-scope deletion fails", async () => {
      const initial = new TelegramConnector({
        id: "telegram-rotation-failure",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890, 67891] },
      });
      await initial.start();
      await new Promise((resolve) => setImmediate(resolve));
      const stateFiles = fs.readdirSync(path.join(JINN_HOME, "state", "telegram-auth-menu-owners"));
      const statePath = path.join(
        JINN_HOME,
        "state",
        "telegram-auth-menu-owners",
        stateFiles[0],
      );
      const previousState = fs.readFileSync(statePath, "utf8");
      mockDeleteMyCommands.mockRejectedValueOnce(new Error("temporary Telegram failure"));

      const rotated = new TelegramConnector({
        id: "telegram-rotation-failure",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await rotated.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(fs.readFileSync(statePath, "utf8")).toBe(previousState);
    });

    it("retains a previously configured owner when refreshing its menu fails", async () => {
      const initial = new TelegramConnector({
        id: "telegram-refresh-failure",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await initial.start();
      await new Promise((resolve) => setImmediate(resolve));
      const stateFiles = fs.readdirSync(path.join(JINN_HOME, "state", "telegram-auth-menu-owners"));
      const statePath = path.join(
        JINN_HOME,
        "state",
        "telegram-auth-menu-owners",
        stateFiles[0],
      );
      const previousState = fs.readFileSync(statePath, "utf8");
      mockSetMyCommands.mockRejectedValueOnce(new Error("temporary Telegram failure"));

      const refreshed = new TelegramConnector({
        id: "telegram-refresh-failure",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await refreshed.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(fs.readFileSync(statePath, "utf8")).toBe(previousState);
    });

    it("clears the previous owner scope when telegramAuth is removed", async () => {
      const initial = new TelegramConnector({
        id: "telegram-disabled",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await initial.start();
      await new Promise((resolve) => setImmediate(resolve));
      mockDeleteMyCommands.mockClear();

      const disabled = new TelegramConnector({
        id: "telegram-disabled",
        botToken: "123456:ABC-DEF",
      });
      await disabled.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockDeleteMyCommands).toHaveBeenCalledWith({
        scope: { type: "chat", chat_id: 67890 },
      });
    });

    it("filters invalid owner IDs before publishing chat-scoped commands", async () => {
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        telegramAuth: {
          enabled: true,
          ownerUserIds: [-1001234567, 0, Number.NaN, 67890, 67890],
        },
      });

      await authConnector.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockSetMyCommands).toHaveBeenCalledTimes(1);
      expect(mockSetMyCommands).toHaveBeenCalledWith(
        expect.any(Array),
        { scope: { type: "chat", chat_id: 67890 } },
      );
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

    it("can be started again after stopping", async () => {
      const handler = vi.fn();
      connector.onMessage(handler);
      await connector.start();
      const firstListener = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      await connector.stop();
      expect(mockRemoveListener).toHaveBeenCalledWith("message", firstListener);
      mockStartPolling.mockClear();

      await connector.start();

      expect(mockStartPolling).toHaveBeenCalledOnce();
      expect(mockOn).toHaveBeenCalledWith("message", expect.any(Function));
      const removedListeners = new Set(
        mockRemoveListener.mock.calls.map((call) => call[1]),
      );
      const message = {
        message_id: 42,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "testuser", first_name: "Test", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "hello",
      };
      for (const callback of mockOn.mock.calls
        .filter((call) => call[0] === "message")
        .map((call) => call[1])
        .filter((callback) => !removedListeners.has(callback))) {
        await callback(message);
      }
      expect(handler).toHaveBeenCalledOnce();
      expect(connector.getHealth().status).toBe("running");
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
        "No authentication flow is active.\nChecking authentication status...",
        {},
      );
      expect(mockSendMessage).toHaveBeenCalledWith(
        "12345",
        "No authentication flow is active.\nClaude: not authenticated.\nCodex: not authenticated.",
        {},
      );
      expect(mockPtySpawn).not.toHaveBeenCalled();
    });

    it("reports authenticated Claude status when the provider probe succeeds", async () => {
      mockClaudeAuthStatus(true);
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await authConnector.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 43,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth_status",
      });

      expect(mockSendMessage).toHaveBeenCalledWith(
        "12345",
        "No authentication flow is active.\nClaude: authenticated.\nCodex: not authenticated.",
        {},
      );
    });

    it("reports provider status as unavailable when the Claude probe cannot run", async () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (
          error: Error | null,
          stdout?: string,
          stderr?: string,
        ) => void;
        queueMicrotask(() => callback(new Error("spawn claude ENOENT"), "", ""));
        return { kill: vi.fn() };
      });
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await authConnector.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 44,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth_status",
      });

      expect(mockSendMessage).toHaveBeenCalledWith(
        "12345",
        "No authentication flow is active.\nClaude: status unavailable.\nCodex: not authenticated.",
        {},
      );
    });

    it("uses a parseable logged-out answer even when Claude exits non-zero", async () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (
          error: Error | null,
          stdout?: string,
          stderr?: string,
        ) => void;
        queueMicrotask(() =>
          callback(
            new Error("claude exited with status 1"),
            JSON.stringify({ loggedIn: false }),
            "",
          ),
        );
        return { kill: vi.fn() };
      });
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await authConnector.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 44,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth_status",
      });

      expect(mockSendMessage).toHaveBeenCalledWith(
        "12345",
        "No authentication flow is active.\nClaude: not authenticated.\nCodex: not authenticated.",
        {},
      );
    });

    it("does not trust an authenticated answer from a failed Claude probe", async () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (
          error: Error | null,
          stdout?: string,
          stderr?: string,
        ) => void;
        queueMicrotask(() =>
          callback(
            new Error("claude exited with status 1"),
            JSON.stringify({ loggedIn: true }),
            "",
          ),
        );
        return { kill: vi.fn() };
      });
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await authConnector.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 44,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth_status",
      });

      expect(mockSendMessage).toHaveBeenCalledWith(
        "12345",
        "No authentication flow is active.\nClaude: status unavailable.\nCodex: not authenticated.",
        {},
      );
    });

    it("reports unavailable for a successful probe with an invalid response shape", async () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (
          error: Error | null,
          stdout?: string,
          stderr?: string,
        ) => void;
        queueMicrotask(() => callback(null, JSON.stringify({ authenticated: true }), ""));
        return { kill: vi.fn() };
      });
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await authConnector.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 44,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth_status",
      });

      expect(mockSendMessage).toHaveBeenCalledWith(
        "12345",
        "No authentication flow is active.\nClaude: status unavailable.\nCodex: not authenticated.",
        {},
      );
    });

    it("renders a provider timeout when the Claude status probe stalls", async () => {
      vi.useFakeTimers();
      mockExecFile.mockImplementation(() => ({ kill: vi.fn() }));
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
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
        text: "/auth_status",
      });

      await vi.advanceTimersByTimeAsync(15_001);
      await statusPromise;

      expect(mockSendMessage).toHaveBeenCalledWith(
        "12345",
        "No authentication flow is active.\nClaude: verification timed out.\nCodex: not authenticated.",
        {},
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
        text: "/auth_claude",
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

    it("retries a transient plain-text authentication send", async () => {
      mockSendMessage
        .mockRejectedValueOnce(
          Object.assign(new Error("temporary Telegram failure"), { code: "EFATAL" }),
        )
        .mockResolvedValueOnce({ message_id: 2 });
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await authConnector.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 43,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth_claude",
      });

      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      expect(mockSendMessage.mock.calls[0][2]).toEqual({});
      expect(mockSendMessage.mock.calls[1][2]).toEqual({});
    });

    it("does not retry a non-transport plain-text authentication failure", async () => {
      mockSendMessage.mockRejectedValueOnce(new Error("Bad Request: chat not found"));
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await authConnector.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 43,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth_claude",
      });

      expect(mockSendMessage).toHaveBeenCalledOnce();
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
      expect(mockDeleteMessage).not.toHaveBeenCalled();
      expect(mockPtySpawn).not.toHaveBeenCalled();
    });

    it("deletes non-owner auth payloads when allowFrom is unset", async () => {
      const authConnector = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await authConnector.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 45,
        chat: { id: 12345, type: "private" as const },
        from: { id: 99999, username: "stranger", first_name: "Stranger", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth_token=secret-value",
      });

      expect(mockDeleteMessage).toHaveBeenCalledWith("12345", 45);
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
        {},
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
    it("sends a message to the target chat", async () => {
      const target: Target = { channel: "12345" };
      await connector.sendMessage(target, "Hello!");
      expect(mockSendMessage).toHaveBeenCalledWith("12345", "Hello!", {
        parse_mode: "Markdown",
      });
    });

    it("does not send empty messages", async () => {
      const target: Target = { channel: "12345" };
      await connector.sendMessage(target, "");
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("chunks long messages", async () => {
      const target: Target = { channel: "12345" };
      const longText = "A".repeat(5000);
      await connector.sendMessage(target, longText);
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });

    it("retries without parse_mode on Markdown parse error", async () => {
      mockSendMessage
        .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
        .mockResolvedValueOnce({ message_id: 2 });
      const target: Target = { channel: "12345" };
      const result = await connector.sendMessage(target, "**bad markdown");
      // First call with Markdown, second without
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      expect(mockSendMessage.mock.calls[0][2]).toEqual({ parse_mode: "Markdown" });
      expect(mockSendMessage.mock.calls[1][2]).toEqual({});
      expect(result).toBe("2");
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
