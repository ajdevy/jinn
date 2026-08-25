import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fixtures from "./telegram-auth-test-setup.js";

describe("Telegram auth menu configuration", () => {
  beforeEach(() => {
    fixtures.resetAuthFixtures("config");
  });

  afterEach(() => fixtures.resetMenuMocks());

    it("clears the previous owner scope when telegramAuth is removed", async () => {
      const initial = new fixtures.TelegramConnector({
        id: "telegram-disabled",
        botToken: "123456:ABC-DEF",
        telegramAuth: { enabled: true, ownerUserIds: [67890] },
      });
      await initial.start();
      await new Promise((resolve) => setImmediate(resolve));
      fixtures.mockDeleteMyCommands.mockClear();

      const disabled = new fixtures.TelegramConnector({
        id: "telegram-disabled",
        botToken: "123456:ABC-DEF",
      });
      await disabled.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(fixtures.mockDeleteMyCommands).toHaveBeenCalledWith({
        scope: { type: "chat", chat_id: 67890 },
      });
    });

    it("filters invalid owner IDs before publishing chat-scoped commands", async () => {
      const authConnector = new fixtures.TelegramConnector({
        botToken: "123456:ABC-DEF",
        telegramAuth: {
          enabled: true,
          ownerUserIds: [-1001234567, 0, Number.NaN, 67890, 67890],
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

});
