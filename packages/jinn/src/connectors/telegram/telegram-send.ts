import TelegramBot, { type SendMessageParams } from "node-telegram-bot-api";
import { stripTelegramMarkdown } from "./format.js";
import type { AuthLogger } from "./auth-flow-types.js";

type SendOptions = Omit<SendMessageParams, "chat_id" | "text">;
type TelegramSendOptions = SendOptions & { markdown?: boolean; logger: AuthLogger };
const RETRY_DELAY_MS = 250;

function retryable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { code?: unknown; response?: { status?: unknown } };
  return value.code === "EFATAL" || ((value.code === "EPARSE" || value.code === "ETELEGRAM") && typeof value.response?.status === "number" && value.response.status >= 500);
}

async function retryPlainText(
  input: { bot: TelegramBot; chatId: string; text: string; options: SendOptions; error: unknown; logger: AuthLogger },
): Promise<string | undefined> {
  const { bot, chatId, text, options, error, logger } = input;
  if (!retryable(error)) {
    logger.error?.(`[telegram] Plain-text send failed: ${error}`);
    return undefined;
  }
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  try {
    const result = await bot.sendMessage(chatId, text, options);
    return String(result.message_id);
  } catch (retryError) {
    logger.error?.(`[telegram] Plain-text send failed: ${retryError}`);
    return undefined;
  }
}

async function sendMarkdownFallback(
  bot: TelegramBot,
  chatId: string,
  text: string,
  options: SendOptions,
  logger: AuthLogger,
): Promise<string> {
  try {
    const result = await bot.sendMessage(chatId, stripTelegramMarkdown(text), options);
    return String(result.message_id);
  } catch (retryError) {
    logger.error?.(`[telegram] Send failed: ${retryError}`);
    throw retryError;
  }
}

export async function sendTelegramMessage(
  bot: TelegramBot,
  chatId: string,
  text: string,
  options: TelegramSendOptions,
): Promise<string | undefined> {
  const { markdown = true, logger, ...telegramOptions } = options;
  const sendOptions = markdown ? { parse_mode: "Markdown", ...telegramOptions } : telegramOptions;
  try {
    const result = await bot.sendMessage(chatId, text, sendOptions);
    return String(result.message_id);
  } catch (error) {
    if (!markdown) return retryPlainText({ bot, chatId, text, options: telegramOptions, error, logger });
    logger.warn?.(`[telegram] Send failed with Markdown, retrying as plain text: ${error}`);
    return sendMarkdownFallback(bot, chatId, text, telegramOptions, logger);
  }
}
