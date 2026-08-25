import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "../../../shared/types.js";
import * as fixtures from "./telegram-auth-test-setup.js";

describe("Telegram auth routing", () => {
  beforeEach(() => {
    fixtures.resetAuthFixtures("routing");
  });

  afterEach(() => fixtures.resetMenuMocks());

    it("starts owner auth without calling the normal handler", async () => {
      const authConnector = new fixtures.TelegramConnector({
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

      const messageCallback = fixtures.mockOn.mock.calls.find(
        (call: any) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 43,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth_claude",
      });

      expect(handler).not.toHaveBeenCalled();
      expect(fixtures.mockPtySpawn).toHaveBeenCalledWith(
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
      fixtures.mockSendMessage
        .mockRejectedValueOnce(
          Object.assign(new Error("temporary Telegram failure"), { code: "EFATAL" }),
        )
        .mockResolvedValueOnce({ message_id: 2 });
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
        text: "/auth_claude",
      });

      expect(fixtures.mockSendMessage).toHaveBeenCalledTimes(2);
      expect(fixtures.mockSendMessage.mock.calls[0][2]).toEqual({});
      expect(fixtures.mockSendMessage.mock.calls[1][2]).toEqual({});
    });

    it("does not retry a non-transport plain-text authentication failure", async () => {
      fixtures.mockSendMessage.mockRejectedValueOnce(new Error("Bad Request: chat not found"));
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
        text: "/auth_claude",
      });

      expect(fixtures.mockSendMessage).toHaveBeenCalledOnce();
    });

    it("deletes owner auth input best-effort without calling the normal handler", async () => {
      const authConnector = new fixtures.TelegramConnector({
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

      const messageCallback = fixtures.mockOn.mock.calls.find(
        (call: any) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 44,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth input AB12-CD34",
      });

      expect(handler).not.toHaveBeenCalled();
      expect(fixtures.mockDeleteMessage).toHaveBeenCalledWith("12345", 44);
    });

    it("ignores non-owner auth text after allowFrom without normal routing", async () => {
      const authConnector = new fixtures.TelegramConnector({
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

      const messageCallback = fixtures.mockOn.mock.calls.find(
        (call: any) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 45,
        chat: { id: 12345, type: "private" as const },
        from: { id: 99999, username: "stranger", first_name: "Stranger", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth status",
      });

      expect(handler).not.toHaveBeenCalled();
      expect(fixtures.mockSendMessage).not.toHaveBeenCalled();
      expect(fixtures.mockDeleteMessage).not.toHaveBeenCalled();
      expect(fixtures.mockPtySpawn).not.toHaveBeenCalled();
    });

    it("deletes non-owner auth payloads when allowFrom is unset", async () => {
      const authConnector = new fixtures.TelegramConnector({
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await authConnector.start();

      const messageCallback = fixtures.mockOn.mock.calls.find(
        (call: any) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 45,
        chat: { id: 12345, type: "private" as const },
        from: { id: 99999, username: "stranger", first_name: "Stranger", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth_token=secret-value",
      });

      expect(fixtures.mockDeleteMessage).toHaveBeenCalledWith("12345", 45);
      expect(fixtures.mockSendMessage).not.toHaveBeenCalled();
      expect(fixtures.mockPtySpawn).not.toHaveBeenCalled();
    });

    it("rejects owner auth commands in groups without normal routing", async () => {
      const authConnector = new fixtures.TelegramConnector({
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

      const messageCallback = fixtures.mockOn.mock.calls.find(
        (call: any) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 46,
        chat: { id: -10012345, type: "group" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "/auth status",
      });

      expect(handler).not.toHaveBeenCalled();
      expect(fixtures.mockSendMessage).toHaveBeenCalledWith(
        "-10012345",
        "Authentication commands are available only in a private chat.",
        {},
      );
    });

    it("routes ordinary owner messages unchanged when auth is enabled", async () => {
      const authConnector = new fixtures.TelegramConnector({
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

      const messageCallback = fixtures.mockOn.mock.calls.find(
        (call: any) => call[0] === "message",
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
      expect(fixtures.mockSendMessage).not.toHaveBeenCalled();
    });

});
