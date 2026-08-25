import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fixtures from "./telegram-auth-test-setup.js";

describe("Telegram auth status", () => {
  let connector: InstanceType<typeof fixtures.TelegramConnector>;

  beforeEach(() => {
    fixtures.resetAuthFixtures("status");
    connector = fixtures.makeConnector();
  });

  afterEach(() => fixtures.resetMenuMocks());

    it("preserves default-disabled auth text routing", async () => {
      const handler = vi.fn();
      connector.onMessage(handler);
      await connector.start();

      const messageCallback = fixtures.mockOn.mock.calls.find(
        (call: any) => call[0] === "message",
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
      expect(fixtures.mockSendMessage).not.toHaveBeenCalled();
      expect(fixtures.mockPtySpawn).not.toHaveBeenCalled();
    });

    it("handles owner auth status without a normal handler", async () => {
      const authConnector = new fixtures.TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: {
          enabled: true,
          ownerUserIds: [67890],
        },
      });
      await authConnector.start();

      const messageCallback = fixtures.mockOn.mock.calls.find(
        (call: any) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 42,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth status",
      });

      expect(fixtures.mockSendMessage).toHaveBeenCalledWith(
        "12345",
        "No authentication flow is active.\nChecking authentication status...",
        {},
      );
      expect(fixtures.mockSendMessage).toHaveBeenCalledWith(
        "12345",
        "No authentication flow is active.\nClaude: not authenticated.\nCodex: not authenticated.",
        {},
      );
      expect(fixtures.mockPtySpawn).not.toHaveBeenCalled();
    });

    it("reports authenticated Claude status when the provider probe succeeds", async () => {
      fixtures.mockClaudeAuthStatus(true);
      const authConnector = new fixtures.TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await authConnector.start();

      const messageCallback = fixtures.mockOn.mock.calls.find(
        (call: any) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 43,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth_status",
      });

      expect(fixtures.mockSendMessage).toHaveBeenCalledWith(
        "12345",
        "No authentication flow is active.\nClaude: authenticated.\nCodex: not authenticated.",
        {},
      );
    });

    it("reports provider status as unavailable when the Claude probe cannot run", async () => {
      fixtures.mockExecFile.mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (
          error: Error | null,
          stdout?: string,
          stderr?: string,
        ) => void;
        queueMicrotask(() => callback(new Error("spawn claude ENOENT"), "", ""));
        return { kill: vi.fn() };
      });
      const authConnector = new fixtures.TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await authConnector.start();

      const messageCallback = fixtures.mockOn.mock.calls.find(
        (call: any) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 44,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth_status",
      });

      expect(fixtures.mockSendMessage).toHaveBeenCalledWith(
        "12345",
        "No authentication flow is active.\nClaude: status unavailable.\nCodex: not authenticated.",
        {},
      );
    });

    it("uses a parseable logged-out answer even when Claude exits non-zero", async () => {
      fixtures.mockExecFile.mockImplementation((...args: unknown[]) => {
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
      const authConnector = new fixtures.TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await authConnector.start();

      const messageCallback = fixtures.mockOn.mock.calls.find(
        (call: any) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 44,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth_status",
      });

      expect(fixtures.mockSendMessage).toHaveBeenCalledWith(
        "12345",
        "No authentication flow is active.\nClaude: not authenticated.\nCodex: not authenticated.",
        {},
      );
    });

    it("does not trust an authenticated answer from a failed Claude probe", async () => {
      fixtures.mockExecFile.mockImplementation((...args: unknown[]) => {
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
      const authConnector = new fixtures.TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await authConnector.start();

      const messageCallback = fixtures.mockOn.mock.calls.find(
        (call: any) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 44,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth_status",
      });

      expect(fixtures.mockSendMessage).toHaveBeenCalledWith(
        "12345",
        "No authentication flow is active.\nClaude: status unavailable.\nCodex: not authenticated.",
        {},
      );
    });

    it("reports unavailable for a successful probe with an invalid response shape", async () => {
      fixtures.mockExecFile.mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (
          error: Error | null,
          stdout?: string,
          stderr?: string,
        ) => void;
        queueMicrotask(() => callback(null, JSON.stringify({ authenticated: true }), ""));
        return { kill: vi.fn() };
      });
      const authConnector = new fixtures.TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await authConnector.start();

      const messageCallback = fixtures.mockOn.mock.calls.find(
        (call: any) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 44,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth_status",
      });

      expect(fixtures.mockSendMessage).toHaveBeenCalledWith(
        "12345",
        "No authentication flow is active.\nClaude: status unavailable.\nCodex: not authenticated.",
        {},
      );
    });

    it("renders a provider timeout when the Claude status probe stalls", async () => {
      vi.useFakeTimers();
      fixtures.mockExecFile.mockImplementation(() => ({ kill: vi.fn() }));
      const authConnector = new fixtures.TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await authConnector.start();

      const messageCallback = fixtures.mockOn.mock.calls.find(
        (call: any) => call[0] === "message",
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

      expect(fixtures.mockSendMessage).toHaveBeenCalledWith(
        "12345",
        "No authentication flow is active.\nClaude: verification timed out.\nCodex: not authenticated.",
        {},
      );
    });

});
