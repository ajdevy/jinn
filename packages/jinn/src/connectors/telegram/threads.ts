import type { ReplyContext } from "../../shared/types.js";

export interface TelegramMessageLike {
  chat: { id: number; type: string; username?: string; title?: string };
  message_id: number;
  from?: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  sender_chat?: { id: number; type: string; username?: string; title?: string };
  date?: number;
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessageLike;
  photo?: unknown[];
  document?: unknown;
  video?: unknown;
  audio?: unknown;
  voice?: unknown;
  video_note?: unknown;
  animation?: unknown;
  sticker?: unknown;
}

/** Derive a session key from a Telegram message. Format: `<prefix>:<chatId>`. */
export function deriveSessionKey(msg: TelegramMessageLike, prefix = "telegram"): string {
  return `${prefix}:${msg.chat.id}`;
}

/**
 * Build a reply context from a Telegram message.
 */
export function buildReplyContext(msg: TelegramMessageLike): ReplyContext {
  return {
    chatId: msg.chat.id,
    messageId: msg.message_id,
  };
}

function telegramAuthor(msg: TelegramMessageLike): string {
  if (msg.from?.username) return `@${msg.from.username}`;

  const name = [msg.from?.first_name, msg.from?.last_name]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  if (name) return name;
  if (msg.sender_chat?.username) return `@${msg.sender_chat.username}`;
  if (msg.sender_chat?.title) return msg.sender_chat.title;
  return "unknown";
}

function telegramMediaKinds(msg: TelegramMessageLike): string {
  const media = [
    ["photo", Array.isArray(msg.photo) && msg.photo.length > 0],
    ["document", Boolean(msg.document)],
    ["video", Boolean(msg.video)],
    ["audio", Boolean(msg.audio)],
    ["voice", Boolean(msg.voice)],
    ["video_note", Boolean(msg.video_note)],
    ["animation", Boolean(msg.animation)],
    ["sticker", Boolean(msg.sticker)],
  ]
    .filter(([, present]) => present)
    .map(([kind]) => kind);
  return media.length > 0 ? media.join(", ") : "none";
}

/**
 * Keep a Telegram reply's quoted message explicit and separate from the new
 * inbound text so the engine receives one prompt and one inbound turn.
 */
export function buildEnginePrompt(messageText: string, msg: TelegramMessageLike): string {
  const quoted = msg.reply_to_message;
  if (!quoted) return messageText;

  const quotedText =
    typeof quoted.text === "string"
      ? quoted.text
      : typeof quoted.caption === "string"
        ? quoted.caption
        : "(no text)";
  const currentText = messageText || "(no text; see attached media)";

  return [
    "<telegram-reply-context>",
    `author: ${telegramAuthor(quoted)}`,
    `message_id: ${quoted.message_id}`,
    `chat_id: ${quoted.chat.id}`,
    "quoted_text:",
    quotedText,
    `quoted_media: ${telegramMediaKinds(quoted)}`,
    "</telegram-reply-context>",
    "<telegram-user-message>",
    currentText,
    "</telegram-user-message>",
  ].join("\n");
}

/**
 * Check if a Telegram message predates the gateway boot time.
 * Telegram dates are Unix timestamps in seconds; bootTimeMs is in milliseconds.
 */
export function isOldTelegramMessage(
  date: number | undefined,
  bootTimeMs: number,
): boolean {
  if (date === undefined) return false;
  return date * 1000 < bootTimeMs;
}
