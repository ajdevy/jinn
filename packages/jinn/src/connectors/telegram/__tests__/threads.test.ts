import { describe, it, expect } from "vitest";
import { deriveSessionKey, buildReplyContext, buildEnginePrompt, isOldTelegramMessage } from "../threads.js";

describe("deriveSessionKey", () => {
  it("returns telegram:<chatId> for a private chat", () => {
    expect(
      deriveSessionKey({ chat: { id: 12345, type: "private" }, message_id: 1 }),
    ).toBe("telegram:12345");
  });

  it("returns telegram:<chatId> for a group chat", () => {
    expect(
      deriveSessionKey({ chat: { id: -100999, type: "group" }, message_id: 1 }),
    ).toBe("telegram:-100999");
  });

  it("returns telegram:<chatId> for a supergroup", () => {
    expect(
      deriveSessionKey({ chat: { id: -1001234, type: "supergroup" }, message_id: 1 }),
    ).toBe("telegram:-1001234");
  });

  it("honours a custom instance prefix", () => {
    expect(
      deriveSessionKey({ chat: { id: 12345, type: "private" }, message_id: 1 }, "telegram-support"),
    ).toBe("telegram-support:12345");
  });
});

describe("buildReplyContext", () => {
  it("builds reply context for a private message", () => {
    const ctx = buildReplyContext({
      chat: { id: 12345, type: "private" },
      message_id: 42,
    });
    expect(ctx).toEqual({
      chatId: 12345,
      messageId: 42,
    });
  });

  it("builds reply context for a group message", () => {
    const ctx = buildReplyContext({
      chat: { id: -100999, type: "group" },
      message_id: 99,
    });
    expect(ctx).toEqual({
      chatId: -100999,
      messageId: 99,
    });
  });
});

describe("buildEnginePrompt", () => {
  it("keeps a Telegram reply in an explicit quoted context before the new text", () => {
    const prompt = buildEnginePrompt("Please answer this", {
      chat: { id: 12345, type: "private" },
      message_id: 42,
      text: "The new question",
      reply_to_message: {
        chat: { id: 12345, type: "private" },
        message_id: 41,
        from: { id: 7, username: "quoted_author" },
        text: "The quoted message",
        photo: [{}],
      },
    });

    expect(prompt).toContain("<telegram-reply-context>");
    expect(prompt).toContain("author: @quoted_author");
    expect(prompt).toContain("message_id: 41");
    expect(prompt).toContain("chat_id: 12345");
    expect(prompt).toContain("quoted_text:\nThe quoted message");
    expect(prompt).toContain("quoted_media: photo");
    expect(prompt).toContain("<telegram-user-message>\nPlease answer this");
    expect(prompt.indexOf("<telegram-reply-context>")).toBeLessThan(prompt.indexOf("<telegram-user-message>"));
  });

  it("does not change an ordinary Telegram message without a reply", () => {
    expect(buildEnginePrompt("A normal message", {
      chat: { id: 12345, type: "private" },
      message_id: 43,
      text: "A normal message",
    })).toBe("A normal message");
  });
});

describe("isOldTelegramMessage", () => {
  it("returns true for messages before boot time", () => {
    const bootTime = 1700000000000; // ms
    const msgDate = 1699999990; // seconds — before boot
    expect(isOldTelegramMessage(msgDate, bootTime)).toBe(true);
  });

  it("returns false for messages after boot time", () => {
    const bootTime = 1700000000000;
    const msgDate = 1700000010; // seconds — after boot
    expect(isOldTelegramMessage(msgDate, bootTime)).toBe(false);
  });

  it("returns false for undefined date", () => {
    expect(isOldTelegramMessage(undefined, Date.now())).toBe(false);
  });
});
