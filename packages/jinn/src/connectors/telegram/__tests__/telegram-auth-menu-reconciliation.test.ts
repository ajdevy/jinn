import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as fixtures from "./telegram-auth-test-setup.js";

describe("Telegram auth menu reconciliation", () => {
  beforeEach(() => {
    fixtures.resetAuthFixtures("reconciliation");
  });

  afterEach(() => fixtures.resetMenuMocks());

    it("backs off repeated menu failures instead of retrying immediately", async () => {
      vi.useFakeTimers();
      fixtures.mockSetMyCommands.mockRejectedValue(new Error("temporary Telegram failure"));
      const authConnector = new fixtures.TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });

      await authConnector.start();
      await vi.runAllTimersAsync();
      await fixtures.flushPromises();
      expect(fixtures.mockSetMyCommands).toHaveBeenCalledTimes(1);

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
      await vi.runAllTimersAsync();
      await fixtures.flushPromises();
      expect(fixtures.mockSetMyCommands).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(59_999);
      await messageCallback({
        message_id: 42,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "hello",
      });
      await vi.runAllTimersAsync();
      await fixtures.flushPromises();
      expect(fixtures.mockSetMyCommands).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(1);
      await messageCallback({
        message_id: 43,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "owner", first_name: "Owner", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "hello",
      });
      await fixtures.flushPromises();
      expect(fixtures.mockSetMyCommands).toHaveBeenCalledTimes(3);
    });

    it("reconciles stale owner scopes and persists the current owner set", async () => {
      const initial = new fixtures.TelegramConnector({
        id: "telegram-rotation",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890, 67891] },
      });
      await initial.start();
      await new Promise((resolve) => setImmediate(resolve));
      fixtures.mockSetMyCommands.mockClear();
      fixtures.mockDeleteMyCommands.mockClear();

      const rotated = new fixtures.TelegramConnector({
        id: "telegram-rotation",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await rotated.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(fixtures.mockDeleteMyCommands).toHaveBeenCalledWith({
        scope: { type: "chat", chat_id: 67891 },
      });
      const stateFiles = fs.readdirSync(fixtures.authMenuStateDir());
      expect(stateFiles).toHaveLength(1);
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(fixtures.authMenuStateDir(), stateFiles[0]),
            "utf8",
          ),
        ),
      ).toEqual([67890]);
    });

    it("preserves damaged state without inventing stale owner IDs", async () => {
      const initial = new fixtures.TelegramConnector({
        id: "telegram-damaged-state",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890, 67891] },
      });
      await initial.start();
      await new Promise((resolve) => setImmediate(resolve));
      const stateFiles = fs.readdirSync(fixtures.authMenuStateDir());
      const statePath = path.join(fixtures.authMenuStateDir(), stateFiles[0]);
      fs.writeFileSync(statePath, "[67890, 67891\n", { mode: 0o600 });
      fixtures.mockDeleteMyCommands.mockClear();

      const rotated = new fixtures.TelegramConnector({
        id: "telegram-damaged-state",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await rotated.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(fixtures.mockDeleteMyCommands).not.toHaveBeenCalled();
      const rotatedStateFiles = fs.readdirSync(
        fixtures.authMenuStateDir(),
      );
      expect(rotatedStateFiles.some((file) => file.includes(".corrupt-"))).toBe(true);
      const currentStateFile = rotatedStateFiles.find(
        (file) => !file.includes(".corrupt-"),
      );
      expect(currentStateFile).toBeDefined();
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(fixtures.authMenuStateDir(), currentStateFile!),
            "utf8",
          ),
        ),
      ).toEqual([67890]);
    });

    it("keeps the owner ledger intact across a transient state-file read failure", async () => {
      const initial = new fixtures.TelegramConnector({
        id: "telegram-read-failure",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890, 67891] },
      });
      await initial.start();
      await new Promise((resolve) => setImmediate(resolve));
      fixtures.mockDeleteMyCommands.mockClear();

      const readFileSpy = vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
      });
      const rotated = new fixtures.TelegramConnector({
        id: "telegram-read-failure",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });

      await rotated.start();
      await new Promise((resolve) => setImmediate(resolve));
      readFileSpy.mockRestore();

      expect(fixtures.mockDeleteMyCommands).toHaveBeenCalledWith({
        scope: { type: "chat", chat_id: 67891 },
      });
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

    it("keeps the previous owner state when stale-scope deletion fails", async () => {
      const initial = new fixtures.TelegramConnector({
        id: "telegram-rotation-failure",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890, 67891] },
      });
      await initial.start();
      await new Promise((resolve) => setImmediate(resolve));
      const stateFiles = fs.readdirSync(fixtures.authMenuStateDir());
      const statePath = path.join(fixtures.authMenuStateDir(), stateFiles[0]);
      const previousState = fs.readFileSync(statePath, "utf8");
      fixtures.mockDeleteMyCommands.mockRejectedValueOnce(new Error("temporary Telegram failure"));

      const rotated = new fixtures.TelegramConnector({
        id: "telegram-rotation-failure",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await rotated.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(fs.readFileSync(statePath, "utf8")).toBe(previousState);
    });

    it("retains a previously configured owner when refreshing its menu fails", async () => {
      const initial = new fixtures.TelegramConnector({
        id: "telegram-refresh-failure",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await initial.start();
      await new Promise((resolve) => setImmediate(resolve));
      const stateFiles = fs.readdirSync(fixtures.authMenuStateDir());
      const statePath = path.join(fixtures.authMenuStateDir(), stateFiles[0]);
      const previousState = fs.readFileSync(statePath, "utf8");
      fixtures.mockSetMyCommands.mockRejectedValueOnce(new Error("temporary Telegram failure"));

      const refreshed = new fixtures.TelegramConnector({
        id: "telegram-refresh-failure",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await refreshed.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(fs.readFileSync(statePath, "utf8")).toBe(previousState);
    });

});
