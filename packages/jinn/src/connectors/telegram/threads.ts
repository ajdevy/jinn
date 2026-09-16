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
  forward_origin?: unknown;
  forward_from?: unknown;
  forward_from_chat?: unknown;
  forward_sender_name?: unknown;
  forward_date?: unknown;
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
  const context: ReplyContext = {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    chatType: msg.chat.type,
  };
  if (msg.from?.id !== undefined) {
    context.userId = msg.from.id;
  }
  return context;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function telegramEntityAuthor(value: unknown): string | undefined {
  const entity = asRecord(value);
  if (!entity) return undefined;

  if (typeof entity.username === "string" && entity.username) {
    return `@${entity.username}`;
  }

  const name = [entity.first_name, entity.last_name]
    .filter((part): part is string => typeof part === "string" && Boolean(part))
    .join(" ");
  if (name) return name;

  if (typeof entity.title === "string" && entity.title) return entity.title;

  const id = finiteNumber(entity.id);
  return id === undefined ? undefined : `id: ${id}`;
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

type ForwardContextDetails = {
  type?: string;
  author?: string;
  date?: number;
  originMessageId?: number;
};

function readForwardOrigin(value: unknown): ForwardContextDetails {
  const origin = asRecord(value);
  const type = nonEmptyString(origin?.type);
  if (!origin || !type) return {};

  const sender = origin.sender_user ?? origin.sender_chat ?? origin.chat;
  const author = telegramEntityAuthor(sender);
  const signature = nonEmptyString(origin.author_signature);
  return {
    type,
    author: author && signature
      ? `${author} (${signature})`
      : author ?? nonEmptyString(origin.sender_user_name) ?? signature,
    date: finiteNumber(origin.date),
    originMessageId: finiteNumber(origin.message_id),
  };
}

function readLegacyForward(msg: TelegramMessageLike): ForwardContextDetails {
  return {
    author: [
      telegramEntityAuthor(msg.forward_from),
      telegramEntityAuthor(msg.forward_from_chat),
      nonEmptyString(msg.forward_sender_name),
    ].find((author): author is string => Boolean(author)),
    date: finiteNumber(msg.forward_date),
  };
}

function telegramForwardedText(msg: TelegramMessageLike): string {
  return nonEmptyString(msg.text) ??
    nonEmptyString(msg.caption) ??
    "(no text; see attached media)";
}

function telegramUserMessageText(
  messageText: string,
  msg: TelegramMessageLike,
  hasForwardContext: boolean,
): string {
  const forwardedText = nonEmptyString(msg.text) ?? nonEmptyString(msg.caption);
  if (hasForwardContext &&
    ((!forwardedText && !messageText) || forwardedText === messageText)) {
    return "(no additional user text; see forwarded content above)";
  }
  return messageText || "(no text; see attached media)";
}

function appendForwardMetadata(
  lines: string[],
  origin: ForwardContextDetails,
  legacy: ForwardContextDetails,
): void {
  const date = origin.date ?? legacy.date;
  if (date !== undefined) lines.push(`forward_date: ${date}`);
  if (origin.originMessageId !== undefined) {
    lines.push(`origin_message_id: ${origin.originMessageId}`);
  }
}

/**
 * Normalize Bot API 7.x MessageOrigin data while keeping old forward fields
 * usable for updates produced by older Telegram clients or libraries.
 */
export function buildForwardContext(msg: TelegramMessageLike): string | null {
  const origin = readForwardOrigin(msg.forward_origin);
  const legacy = readLegacyForward(msg);
  if (!origin.type && !legacy.author && legacy.date === undefined) return null;

  const media = telegramMediaKinds(msg);
  const contentType = media === "none" ? "text" : media;
  const lines = [
    "<telegram-forward-context>",
    `forward_type: ${origin.type ?? "legacy"}`,
    `author: ${origin.author ?? legacy.author ?? "unknown"}`,
  ];
  appendForwardMetadata(lines, origin, legacy);
  lines.push(
    "forwarded_text:",
    telegramForwardedText(msg),
    `forwarded_media: ${media}`,
    `content_type: ${contentType}`,
    "</telegram-forward-context>",
  );
  return lines.join("\n");
}

/**
 * Keep a Telegram reply's quoted message explicit and separate from the new
 * inbound text so the engine receives one prompt and one inbound turn.
 */
export function buildEnginePrompt(messageText: string, msg: TelegramMessageLike): string {
  const quoted = msg.reply_to_message;
  const forwardContext = buildForwardContext(msg);
  if (!quoted && !forwardContext) return messageText;

  const sections: string[] = [];
  if (forwardContext) sections.push(forwardContext);

  if (quoted) {
    const quotedText =
      typeof quoted.text === "string"
        ? quoted.text
        : typeof quoted.caption === "string"
          ? quoted.caption
          : "(no text)";
    sections.push([
      "<telegram-reply-context>",
      `author: ${telegramAuthor(quoted)}`,
      `message_id: ${quoted.message_id}`,
      `chat_id: ${quoted.chat.id}`,
      "quoted_text:",
      quotedText,
      `quoted_media: ${telegramMediaKinds(quoted)}`,
      "</telegram-reply-context>",
    ].join("\n"));
  }

  sections.push(
    "<telegram-user-message>",
    telegramUserMessageText(messageText, msg, Boolean(forwardContext)),
    "</telegram-user-message>",
  );
  return sections.join("\n");
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
