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
  it("includes Bot API forward_origin context before the forwarded text", () => {
    const prompt = buildEnginePrompt("Forwarded question", {
      chat: { id: 12345, type: "private" },
      message_id: 44,
      text: "Forwarded question",
      forward_origin: {
        type: "user",
        date: 1700000000,
        sender_user: { id: 7, username: "forwarded_author" },
      },
    });

    expect(prompt).toContain("<telegram-forward-context>");
    expect(prompt).toContain("forward_type: user");
    expect(prompt).toContain("author: @forwarded_author");
    expect(prompt).toContain("forwarded_text:\nForwarded question");
    expect(prompt).toContain("forwarded_media: none");
    expect(prompt.indexOf("<telegram-forward-context>")).toBeLessThan(
      prompt.indexOf("<telegram-user-message>"),
    );
  });

  it("falls back to legacy forward fields and includes media type", () => {
    const prompt = buildEnginePrompt("A forwarded caption", {
      chat: { id: 12345, type: "private" },
      message_id: 45,
      caption: "A forwarded caption",
      photo: [{}],
      forward_from: { id: 8, first_name: "Legacy", last_name: "Author" },
      forward_date: 1700000001,
    });

    expect(prompt).toContain("forward_type: legacy");
    expect(prompt).toContain("author: Legacy Author");
    expect(prompt).toContain("forwarded_text:\nA forwarded caption");
    expect(prompt).toContain("forwarded_media: photo");
  });

  it("handles absent, partial, and malformed forward context without throwing", () => {
    expect(buildEnginePrompt("No forward", {
      chat: { id: 12345, type: "private" },
      message_id: 46,
      text: "No forward",
    })).toBe("No forward");

    const partial = buildEnginePrompt("Partial forward", {
      chat: { id: 12345, type: "private" },
      message_id: 47,
      text: "Partial forward",
      forward_origin: { type: "hidden_user" },
    });
    expect(partial).toContain("<telegram-forward-context>");
    expect(partial).toContain("author: unknown");

    const malformed = buildEnginePrompt("Malformed forward", {
      chat: { id: 12345, type: "private" },
      message_id: 48,
      text: "Malformed forward",
      forward_origin: "not-an-origin",
      forward_from: { id: "not-a-number" },
    });
    expect(malformed).toBe("Malformed forward");
  });

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

  it("keeps forward and reply contexts separate", () => {
    const prompt = buildEnginePrompt("Current text", {
      chat: { id: 12345, type: "private" },
      message_id: 49,
      text: "Current text",
      forward_origin: {
        type: "chat",
        sender_chat: { id: -1001, title: "Forwarded channel" },
      },
      reply_to_message: {
        chat: { id: 12345, type: "private" },
        message_id: 48,
        text: "Quoted text",
      },
    });

    expect(prompt.indexOf("<telegram-forward-context>")).toBeLessThan(
      prompt.indexOf("<telegram-reply-context>"),
    );
    expect(prompt).toContain("author: Forwarded channel");
    expect(prompt).toContain("quoted_text:\nQuoted text");
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
