import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as fixtures from "./telegram-auth-test-setup.js";

describe("Telegram auth menu publication", () => {
  beforeEach(() => {
    fixtures.resetAuthFixtures("publication");
  });

  afterEach(() => fixtures.resetMenuMocks());

    it("configures the auth command menu only for each owner chat", async () => {
      const authConnector = new fixtures.TelegramConnector({
        botToken: "123456:ABC-DEF",
        telegramAuth: {
          enabled: true,
          ownerUserIds: [67890, 67891],
        },
      });

      await authConnector.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(fixtures.mockSetMyCommands).toHaveBeenCalledTimes(2);
      expect(fixtures.mockSetMyCommands).toHaveBeenNthCalledWith(
        1,
        [
          { command: "auth_claude", description: "Authenticate Claude" },
          { command: "auth_codex", description: "Authenticate Codex" },
          { command: "auth_status", description: "Show authentication status" },
          { command: "auth_cancel", description: "Cancel current authentication" },
        ],
        { scope: { type: "chat", chat_id: 67890 } },
      );
      expect(fixtures.mockSetMyCommands).toHaveBeenNthCalledWith(
        2,
        expect.any(Array),
        { scope: { type: "chat", chat_id: 67891 } },
      );
    });

    it("publishes owner menus only to users admitted by allowFrom", async () => {
      const authConnector = new fixtures.TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: {
          enabled: true,
          ownerUserIds: [67890, 67891],
        },
      });

      await authConnector.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(fixtures.mockSetMyCommands).toHaveBeenCalledTimes(1);
      expect(fixtures.mockSetMyCommands).toHaveBeenCalledWith(
        expect.any(Array),
        { scope: { type: "chat", chat_id: 67890 } },
      );
    });

    it("retries an owner menu after the chat-not-found publication failure", async () => {
      fixtures.mockSetMyCommands
        .mockRejectedValueOnce(new Error("ETELEGRAM: 400 Bad Request: chat not found"))
        .mockResolvedValueOnce(true);
      const authConnector = new fixtures.TelegramConnector({
        id: "telegram-permanent-current-owner",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });

      await authConnector.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(fixtures.mockSetMyCommands).toHaveBeenCalledOnce();
      const messageCallback = fixtures.mockOn.mock.calls.find(
        (call: any) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 41,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "hello",
      });
      await fixtures.flushPromises();

      expect(fixtures.mockSetMyCommands).toHaveBeenCalledTimes(2);
      const stateFiles = fs.readdirSync(
        fixtures.authMenuStateDir(),
      );
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(fixtures.authMenuStateDir(), stateFiles[0]),
            "utf8",
          ),
        ),
      ).toEqual([67890]);
    });

    it("preserves default Telegram commands in the owner-scoped menu", async () => {
      fixtures.mockGetMyCommands.mockResolvedValueOnce([
        { command: "start", description: "Start" },
      ]);
      const authConnector = new fixtures.TelegramConnector({
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });

      await authConnector.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(fixtures.mockSetMyCommands).toHaveBeenCalledWith(
        expect.arrayContaining([
          { command: "start", description: "Start" },
          { command: "auth_claude", description: "Authenticate Claude" },
        ]),
        { scope: { type: "chat", chat_id: 67890 } },
      );
    });

    it("retries auth menu configuration after a transient startup failure", async () => {
      fixtures.mockSetMyCommands.mockRejectedValueOnce(new Error("temporary Telegram failure"));
      const authConnector = new fixtures.TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: {
          enabled: true,
          ownerUserIds: [67890],
        },
      });

      await authConnector.start();
      await new Promise((resolve) => setImmediate(resolve));
      expect(fixtures.mockSetMyCommands).toHaveBeenCalledOnce();

      const messageCallback = fixtures.mockOn.mock.calls.find(
        (call: any) => call[0] === "message",
      )?.[1];
      await messageCallback({
        message_id: 41,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "hello",
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(fixtures.mockSetMyCommands).toHaveBeenCalledTimes(2);
    });

    it("converges when a stale owner scope is permanently unreachable", async () => {
      const initial = new fixtures.TelegramConnector({
        id: "telegram-permanent-stale",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890, 67891] },
      });
      await initial.start();
      await new Promise((resolve) => setImmediate(resolve));
      fixtures.mockDeleteMyCommands.mockRejectedValueOnce(
        new Error("ETELEGRAM: 400 Bad Request: chat not found"),
      );
      fixtures.mockSetMyCommands.mockClear();

      const rotated = new fixtures.TelegramConnector({
        id: "telegram-permanent-stale",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await rotated.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(fixtures.mockSetMyCommands).toHaveBeenCalledWith(
        expect.any(Array),
        { scope: { type: "chat", chat_id: 67890 } },
      );
      const stateFiles = fs.readdirSync(fixtures.authMenuStateDir());
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(fixtures.authMenuStateDir(), stateFiles[0]),
            "utf8",
          ),
        ),
      ).toEqual([67890]);
    });

    it("retains intent for an owner when setMyCommands acknowledgement is lost", async () => {
      fixtures.mockSetMyCommands
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error("request timed out after Telegram applied it"));
      const initial = new fixtures.TelegramConnector({
        id: "telegram-lost-ack",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890, 67891] },
      });
      await initial.start();
      await new Promise((resolve) => setImmediate(resolve));
      fixtures.mockDeleteMyCommands.mockClear();

      const rotated = new fixtures.TelegramConnector({
        id: "telegram-lost-ack",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await rotated.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(fixtures.mockDeleteMyCommands).toHaveBeenCalledWith({
        scope: { type: "chat", chat_id: 67891 },
      });
    });

    it("retains old and new owners when stale cleanup and publication both fail", async () => {
      const initial = new fixtures.TelegramConnector({
        id: "telegram-stale-lost-ack",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await initial.start();
      await new Promise((resolve) => setImmediate(resolve));
      fixtures.mockDeleteMyCommands.mockRejectedValueOnce(new Error("temporary cleanup failure"));
      fixtures.mockSetMyCommands.mockRejectedValueOnce(new Error("request timed out after apply"));

      const rotated = new fixtures.TelegramConnector({
        id: "telegram-stale-lost-ack",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67891] },
      });
      await rotated.start();
      await new Promise((resolve) => setImmediate(resolve));

      const stateFiles = fs.readdirSync(fixtures.authMenuStateDir());
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(fixtures.authMenuStateDir(), stateFiles[0]),
            "utf8",
          ),
        ),
      ).toEqual([67890, 67891]);
    });

});
