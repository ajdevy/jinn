import type TelegramBot from "node-telegram-bot-api";
import type { SendMessageParams } from "node-telegram-bot-api";
import type { AuthFlowManager } from "./auth-flow.js";
import { buildTelegramAuthReply } from "./auth-connector.js";
import { formatResponse } from "./format.js";
import type { Target } from "../../shared/types.js";

type SendMessageOptions = Omit<SendMessageParams, "chat_id" | "text">;
type SafeSend = (
  chatId: string,
  text: string,
  opts?: SendMessageOptions,
) => Promise<string | undefined>;

export async function sendTelegramMessage(
  target: Target,
  text: string,
  safeSend: SafeSend,
): Promise<string | undefined> {
  if (!text || !text.trim()) return undefined;
  let lastMessageId: string | undefined;
  for (const chunk of formatResponse(text)) {
    if (chunk.trim()) lastMessageId = (await safeSend(target.channel, chunk)) ?? lastMessageId;
  }
  return lastMessageId;
}

export async function replyTelegramMessage(
  target: Target,
  text: string,
  manager: AuthFlowManager | undefined,
  ownerUserIds: ReadonlySet<number>,
  safeSend: SafeSend,
): Promise<string | undefined> {
  if (!text || !text.trim()) return undefined;
  const replyText = buildTelegramAuthReply(target, text, manager, ownerUserIds);
  const replyToId = target.replyContext?.messageId != null ? Number(target.replyContext.messageId) : undefined;
  const opts: SendMessageOptions = replyToId ? { reply_parameters: { message_id: replyToId } } : {};
  let lastMessageId: string | undefined;
  for (const chunk of formatResponse(replyText)) {
    if (chunk.trim()) lastMessageId = (await safeSend(target.channel, chunk, opts)) ?? lastMessageId;
  }
  return lastMessageId;
}

export async function setTelegramTypingStatus(
  bot: TelegramBot,
  typingIntervals: Map<string, ReturnType<typeof setInterval>>,
  channelId: string,
  status: string,
): Promise<void> {
  const existing = typingIntervals.get(channelId);
  if (existing) {
    clearInterval(existing);
    typingIntervals.delete(channelId);
  }
  if (!status) return;
  try {
    await bot.sendChatAction(channelId, "typing");
    const interval = setInterval(async () => {
      try {
        await bot.sendChatAction(channelId, "typing");
      } catch {
        // Telegram typing refresh is best-effort.
      }
    }, 4_000);
    typingIntervals.set(channelId, interval);
  } catch {
    // Telegram typing is best-effort.
  }
}

export async function editTelegramMessage(
  bot: TelegramBot,
  target: Target,
  text: string,
): Promise<void> {
  if (!target.messageTs || !text || !text.trim()) return;
  const [converted] = formatResponse(text);
  await bot.editMessageText(converted, {
    chat_id: target.channel,
    message_id: Number(target.messageTs),
    parse_mode: "Markdown",
  });
}
