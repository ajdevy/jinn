import { AuthFlowRuntime } from "./auth-flow-runtime.js";
import {
  type AuthChatId,
  type AuthCommand,
  type AuthFlowManagerOptions,
  type AuthMessage,
  AUTH_PREFIX_PATTERN,
  SENSITIVE_INPUT_PATTERN,
  defaultClock,
  parseAuthCommand,
} from "./auth-flow-support.js";

export {
  parseAuthCommand,
  redactAuthOutput,
  type AuthChatId,
  type AuthClock,
  type AuthCommand,
  type AuthFlowManagerOptions,
  type AuthLogger,
  type AuthMessage,
  type AuthProvider,
  type AuthPty,
  type AuthSpawnOptions,
  type SpawnPty,
} from "./auth-flow-support.js";

export class AuthFlowManager {
  private readonly ownerUserIds: ReadonlySet<number>;
  private readonly runtime: AuthFlowRuntime;
  private readonly send: AuthFlowManagerOptions["send"];
  private readonly deleteMessage: AuthFlowManagerOptions["deleteMessage"];
  private readonly logger: AuthFlowManagerOptions["logger"];

  constructor(options: AuthFlowManagerOptions) {
    this.ownerUserIds = new Set(options.ownerUserIds);
    this.send = options.send;
    this.deleteMessage = options.deleteMessage;
    this.logger = options.logger;
    this.runtime = new AuthFlowRuntime({
      ...options,
      clock: options.clock ?? defaultClock,
    });
  }

  async handleMessage(message: AuthMessage): Promise<boolean> {
    const rawText = message.text.trim();
    if (!AUTH_PREFIX_PATTERN.test(rawText)) return false;

    const command = parseAuthCommand(message.text);
    const ownerId = this.canonicalOwnerId(message.userId);
    if (ownerId === null) return true;

    if (SENSITIVE_INPUT_PATTERN.test(rawText)) {
      await this.deleteMessageSafely(message);
    }
    if (message.chatType !== "private") {
      await this.sendSafely(
        message.chatId,
        "Authentication commands are available only in a private chat.",
      );
      return true;
    }
    if (!command) {
      await this.sendSafely(message.chatId, "Unsupported authentication command.");
      return true;
    }
    await this.dispatchCommand(ownerId, command, message.chatId);
    return true;
  }

  stop(): void {
    this.runtime.stop();
  }

  private canonicalOwnerId(userId: number | string): number | null {
    const numericId = typeof userId === "number" ? userId : Number(userId);
    return Number.isSafeInteger(numericId) && this.ownerUserIds.has(numericId)
      ? numericId
      : null;
  }

  private async dispatchCommand(
    ownerId: number,
    command: AuthCommand,
    chatId: AuthChatId,
  ): Promise<void> {
    switch (command.kind) {
      case "start":
        await this.runtime.start(ownerId, command.provider, chatId);
        return;
      case "status":
        await this.runtime.status(ownerId, chatId);
        return;
      case "cancel":
        await this.runtime.cancel(ownerId, chatId);
        return;
      case "input":
        await this.runtime.input(ownerId, command.code, chatId);
        return;
      case "rejected":
        await this.sendSafely(
          chatId,
          "Unsupported authentication command. One-time codes must match the short-code format; tokens are not accepted.",
        );
    }
  }

  private async deleteMessageSafely(message: AuthMessage): Promise<void> {
    if (message.messageId === undefined) return;
    try {
      await this.deleteMessage(message.chatId, message.messageId);
    } catch {
      this.logger.debug?.("[telegram-auth] unable to delete sensitive auth message");
    }
  }

  private async sendSafely(chatId: AuthChatId, text: string): Promise<void> {
    try {
      await this.send(chatId, text);
    } catch {
      this.logger.warn?.("[telegram-auth] unable to send auth update");
    }
  }
}
