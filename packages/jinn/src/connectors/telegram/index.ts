import TelegramBot, {
  type Message as TelegramMessage,
  type SendMessageParams,
} from "node-telegram-bot-api";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import type {
  Attachment,
  Connector,
  ConnectorCapabilities,
  ConnectorHealth,
  IncomingMessage,
  ReplyContext,
  Target,
  TelegramConnectorConfig,
} from "../../shared/types.js";
import { deriveSessionKey, buildReplyContext, isOldTelegramMessage } from "./threads.js";
import { formatResponse, stripTelegramMarkdown } from "./format.js";
import { logger } from "../../shared/logger.js";
import { JINN_HOME, TMP_DIR } from "../../shared/paths.js";
import {
  AUTH_MENU_COMMANDS,
  AuthFlowManager,
  type AuthProvider,
} from "./auth-flow.js";
import {
  transcribe as sttTranscribe,
  resolveLanguages,
  getModelPath,
} from "../../stt/stt.js";

type SendMessageOptions = Omit<SendMessageParams, "chat_id" | "text">;
const AUTH_ENV = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/home/node",
  CLAUDE_CONFIG_DIR: "/home/node/.claude",
  CODEX_HOME: "/home/node/.codex",
};
const AUTH_MENU_OWNERS_DIR = path.join(JINN_HOME, "state", "telegram-auth-menu-owners");
const AUTH_MENU_RETRY_DELAY_MS = 60_000;
const AUTH_MENU_MAX_RETRY_DELAY_MS = 15 * 60_000;
const AUTH_SEND_RETRY_DELAY_MS = 250;

function execFileWithTimeout(
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; maxBuffer: number },
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof execFile>;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      callback();
    };

    try {
      child = execFile(file, args, options, (error, stdout, stderr) => {
        finish(() => {
          if (error) {
            const providerError =
              error instanceof Error ? error : new Error(String(error));
            reject(
              Object.assign(providerError, {
                stdout: String(stdout ?? ""),
                stderr: String(stderr ?? ""),
              }),
            );
            return;
          }
          resolve({
            stdout: String(stdout),
            stderr: String(stderr),
          });
        });
      });
    } catch (error) {
      finish(() => reject(error));
      return;
    }

    timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGTERM");
        reject(
          Object.assign(new Error("provider authentication verification timed out"), {
            timedOut: true,
          }),
        );
      });
    }, timeoutMs);
  });
}

function authMenuOwnersFileFor(connectorId: string): string {
  const idHash = createHash("sha256").update(connectorId, "utf8").digest("hex").slice(0, 24);
  return path.join(AUTH_MENU_OWNERS_DIR, `${idHash}.json`);
}

function isValidAuthMenuOwnerId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPermanentStaleMenuError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /\b(?:chat not found|bot was blocked(?: by (?:the )?user)?|user is deactivated)\b/i.test(
    detail,
  );
}

function isTelegramTransportError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "EFATAL"
  );
}

function isRetryableTelegramSendError(error: unknown): boolean {
  if (isTelegramTransportError(error)) {
    return true;
  }
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const providerError = error as {
    code?: unknown;
    response?: { status?: unknown };
  };
  return (
    (providerError.code === "EPARSE" || providerError.code === "ETELEGRAM") &&
    typeof providerError.response?.status === "number" &&
    providerError.response.status >= 500
  );
}

export class TelegramConnector implements Connector {
  name = "telegram";
  id: string;
  private bot: TelegramBot;
  private readonly authMenuBot: TelegramBot | null;
  private handler: ((msg: IncomingMessage) => void) | null = null;
  private readonly allowedUsers: Set<number> | null;
  private readonly ignoreOldMessagesOnBoot: boolean;
  private readonly bootTimeMs = Date.now();
  private started = false;
  private lastError: string | null = null;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  private readonly capabilities: ConnectorCapabilities = {
    threading: false,
    messageEdits: true,
    reactions: false,
    attachments: true,
  };

  private readonly sttConfig?: TelegramConnectorConfig["stt"];
  private readonly authFlowManager?: AuthFlowManager;
  private readonly authMenuOwnerUserIds: readonly number[];
  private readonly authMenuOwnersFile: string;
  private readonly authMenuLifecycleManaged: boolean;
  private authMenuPreviousOwnerUserIds: readonly number[];
  private readonly authMenuConfiguredOwnerUserIds = new Set<number>();
  private readonly authMenuReconciledStaleOwnerUserIds = new Set<number>();
  private authMenuStateUnreadable = false;
  private authMenuStateReadFailed = false;
  private authMenuStatePersisted = false;
  private authMenuConfiguration: Promise<void> | null = null;
  private authMenuConfigurationGeneration: number | null = null;
  private authMenuStopped = false;
  private authMenuLifecycleGeneration = 0;
  private authMenuFailureCount = 0;
  private authMenuRetryNotBefore = 0;
  private sttChain: Promise<unknown> = Promise.resolve();
  private sttPending = 0;
  private messageListener: ((telegramMsg: TelegramMessage) => void) | null = null;

  constructor(config: TelegramConnectorConfig) {
    this.id = config.id || "telegram";
    this.bot = new TelegramBot(config.botToken, { polling: false });
    this.ignoreOldMessagesOnBoot = config.ignoreOldMessagesOnBoot !== false;
    this.allowedUsers =
      config.allowFrom && config.allowFrom.length > 0
        ? new Set(config.allowFrom)
      : null;
    this.sttConfig = config.stt;
    this.authMenuOwnersFile = authMenuOwnersFileFor(this.id);
    this.authMenuPreviousOwnerUserIds = this.readAuthMenuOwners();
    this.authMenuLifecycleManaged =
      config.telegramAuth !== undefined ||
      this.authMenuPreviousOwnerUserIds.length > 0 ||
      this.authMenuStateUnreadable ||
      this.authMenuStateReadFailed;
    this.authMenuBot = this.authMenuLifecycleManaged
      ? new TelegramBot(config.botToken, {
          polling: false,
          request: { timeoutMs: 10_000 },
        })
      : null;
    const configuredOwnerUserIds = config.telegramAuth?.ownerUserIds ?? [];
    if (config.telegramAuth?.enabled) {
      for (const ownerUserId of configuredOwnerUserIds) {
        if (!isValidAuthMenuOwnerId(ownerUserId)) {
          logger.warn(
            `[telegram] Ignoring invalid telegramAuth owner user id: ${String(ownerUserId)}`,
          );
        }
      }
    }
    const validOwnerUserIds = configuredOwnerUserIds.filter(isValidAuthMenuOwnerId);
    const excludedOwnerUserIds = this.allowedUsers
      ? validOwnerUserIds.filter((ownerUserId) => !this.allowedUsers!.has(ownerUserId))
      : [];
    if (excludedOwnerUserIds.length > 0) {
      logger.warn(
        `[telegram] Excluding telegramAuth owners not present in allowFrom: ${excludedOwnerUserIds.join(",")}`,
      );
    }
    this.authMenuOwnerUserIds = config.telegramAuth?.enabled
      ? [...new Set(
          validOwnerUserIds.filter(
            (ownerUserId) => !this.allowedUsers || this.allowedUsers.has(ownerUserId),
          ),
        )]
      : [];
    if (config.telegramAuth?.enabled) {
      this.authFlowManager = new AuthFlowManager({
        ownerUserIds: this.authMenuOwnerUserIds,
        flowTtlSeconds: config.telegramAuth.flowTtlSeconds,
        clock: {
          now: () => Date.now(),
          setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
          clearTimeout: (handle) =>
            clearTimeout(handle as ReturnType<typeof setTimeout>),
        },
        send: async (chatId, text) => {
          await this.safeSend(String(chatId), text, {}, false);
        },
        deleteMessage: async (chatId, messageId) => {
          await this.bot.deleteMessage(String(chatId), Number(messageId));
        },
        spawnPty: (file, args, options) => pty.spawn(file, args, options),
        providerEnv: AUTH_ENV,
        verifyAuth: (provider) => this.verifyProviderAuth(provider),
        deleteSensitiveInputFromNonOwners: true,
        logger,
      });
    }
  }

  async start(): Promise<void> {
    this.authMenuStopped = false;
    this.authMenuLifecycleGeneration += 1;
    try {
      const me = await this.bot.getMe();
      logger.info(`[telegram] Bot started: @${me.username} (id: ${me.id})`);
      this.bot.startPolling();
      this.started = true;
      this.lastError = null;
      void this.configureAuthCommandMenu(this.authMenuLifecycleGeneration);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      logger.error(`[telegram] Failed to start: ${msg}`);
      return;
    }

    this.messageListener = async (telegramMsg) => {
      // Skip bot messages
      if (telegramMsg.from?.is_bot) {
        logger.debug("[telegram] Skipping bot message");
        return;
      }

      if (
        this.ignoreOldMessagesOnBoot &&
        isOldTelegramMessage(telegramMsg.date, this.bootTimeMs)
      ) {
        logger.debug(`[telegram] Ignoring old message ${telegramMsg.message_id}`);
        return;
      }

      const userId = telegramMsg.from?.id;
      if (this.allowedUsers) {
        if (userId === undefined || !this.allowedUsers.has(userId)) {
          logger.debug(
            `[telegram] Ignoring message from unauthorized user ${userId}`,
          );
          return;
        }
      }

      let messageText: string =
        (telegramMsg as any).text || (telegramMsg as any).caption || "";

      if (this.authMenuLifecycleManaged && !this.authMenuStatePersisted) {
        void this.configureAuthCommandMenu();
      }

      if (
        this.authFlowManager &&
        (await this.authFlowManager.handleMessage({
          userId: userId ?? "",
          chatType: telegramMsg.chat.type,
          chatId: telegramMsg.chat.id,
          messageId: telegramMsg.message_id,
          text: messageText,
        }))
      ) {
        return;
      }

      if (!this.handler) {
        logger.debug("[telegram] No handler registered, dropping message");
        return;
      }

      const sessionKey = deriveSessionKey(telegramMsg, this.id);
      const replyContext = buildReplyContext(telegramMsg);

      const username =
        telegramMsg.from?.username || telegramMsg.from?.first_name || "unknown";

      // File attachments: download via bot token and push to msg.attachments.
      // sessions/manager.ts pulls localPath and engines auto-inject
      // "Attached files: …" — no manual text formatting needed here.
      const tg = telegramMsg as any;
      type Spec = { file_id: string; name?: string; mime?: string };
      const specs: Spec[] = [];
      if (tg.document) {
        specs.push({
          file_id: tg.document.file_id,
          name: tg.document.file_name,
          mime: tg.document.mime_type,
        });
      }
      if (tg.photo && tg.photo.length > 0) {
        // Telegram returns size variants; the last is the largest.
        specs.push({
          file_id: tg.photo[tg.photo.length - 1].file_id,
          mime: "image/jpeg",
        });
      }
      if (tg.video) {
        specs.push({
          file_id: tg.video.file_id,
          name: tg.video.file_name,
          mime: tg.video.mime_type || "video/mp4",
        });
      }
      // video_note is intentionally NOT attached here — the STT block below
      // transcribes it instead (avoids double-handling the same message).
      if (tg.animation) {
        specs.push({
          file_id: tg.animation.file_id,
          name: tg.animation.file_name,
          mime: tg.animation.mime_type || "video/mp4",
        });
      }
      if (tg.sticker) {
        specs.push({
          file_id: tg.sticker.file_id,
          mime: tg.sticker.is_animated
            ? "application/x-tgsticker"
            : "image/webp",
        });
      }

      const attachments: Attachment[] = [];
      if (specs.length > 0) {
        fs.mkdirSync(TMP_DIR, { recursive: true });
        for (const spec of specs) {
          try {
            const downloaded: string = await (this.bot as any).downloadFile(
              spec.file_id,
              TMP_DIR,
            );
            // Rename to a UUID so repeat Telegram basenames don't collide
            // (matches the Slack connector's downloadAttachment pattern).
            const ext =
              path.extname(downloaded) ||
              (spec.name ? path.extname(spec.name) : "");
            const localPath = path.join(TMP_DIR, `${randomUUID()}${ext}`);
            fs.renameSync(downloaded, localPath);
            attachments.push({
              name: spec.name || path.basename(downloaded),
              url: localPath,
              mimeType: spec.mime || "application/octet-stream",
              localPath,
            });
          } catch (err) {
            logger.warn(
              `[telegram] Failed to download attachment: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      }

      // Voice / audio / video_note → transcribe via STT module.
      // If STT can't run for any reason, drop the message with a user-facing
      // explanation rather than forwarding empty text downstream (which would
      // crash session resume — see #54).
      const voiceLike =
        (telegramMsg as any).voice ||
        (telegramMsg as any).audio ||
        (telegramMsg as any).video_note;

      if (voiceLike) {
        const model = this.sttConfig?.model || "small";
        let unavailable: string | null = null;
        if (!this.sttConfig?.enabled) {
          unavailable = "voice transcription is not enabled on this gateway";
        } else if (!getModelPath(model)) {
          unavailable = `STT model '${model}' is not downloaded`;
        }

        if (unavailable) {
          logger.warn(`[telegram] Dropping voice message: ${unavailable}`);
          try {
            await this.bot.sendMessage(
              telegramMsg.chat.id,
              `⚠️ Couldn't transcribe your voice message — ${unavailable}. Please type instead.`,
            );
          } catch {
            /* non-fatal */
          }
          return;
        }

        const langs = resolveLanguages(this.sttConfig);
        const language = langs.length === 1 ? langs[0] : "auto";

        // Serialize transcriptions: parallel whisper-cli runs OOM on small hosts.
        // If another transcription is already in flight, send a one-line ack so
        // the user doesn't sit through ~duration × queue position in silence.
        this.sttPending++;
        if (this.sttPending > 1) {
          try {
            await this.bot.sendMessage(
              telegramMsg.chat.id,
              "⏳ Transcribing a previous voice message — yours is queued.",
            );
          } catch {
            /* non-fatal */
          }
        }

        const myTurn = this.sttChain.then(async () => {
          try {
            await this.bot.sendChatAction(telegramMsg.chat.id, "typing");
          } catch {
            /* non-fatal */
          }
          logger.info(
            `[telegram] Transcribing voice message (${voiceLike.duration}s, lang=${language})`,
          );
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-stt-"));
          try {
            const localPath = await (this.bot as any).downloadFile(
              voiceLike.file_id,
              tmpDir,
            );
            return await sttTranscribe(localPath, model, language);
          } finally {
            try {
              fs.rmSync(tmpDir, { recursive: true, force: true });
            } catch {
              /* non-fatal */
            }
          }
        });
        this.sttChain = myTurn
          .catch(() => undefined)
          .finally(() => {
            this.sttPending = Math.max(0, this.sttPending - 1);
          });

        let transcript: string | undefined;
        try {
          transcript = await myTurn;
        } catch (err) {
          logger.error(
            `[telegram] STT failed: ${err instanceof Error ? err.message : err}`,
          );
          try {
            await this.bot.sendMessage(
              telegramMsg.chat.id,
              "⚠️ Couldn't transcribe your voice message. Please try again or type instead.",
            );
          } catch {
            /* non-fatal */
          }
          return;
        }

        if (transcript) {
          messageText = messageText
            ? `${messageText}\n\n${transcript}`
            : transcript;
          logger.info(`[telegram] Transcribed ${transcript.length} chars`);
        } else {
          logger.warn("[telegram] Transcription returned empty text");
          try {
            await this.bot.sendMessage(
              telegramMsg.chat.id,
              "⚠️ Couldn't make out anything in your voice message. Please try again or type instead.",
            );
          } catch {
            /* non-fatal */
          }
          return;
        }
      }

      const msg: IncomingMessage = {
        connector: this.id,
        source: "telegram",
        sessionKey,
        replyContext,
        messageId: String(telegramMsg.message_id),
        channel: String(telegramMsg.chat.id),
        user: username,
        userId: String(userId ?? "unknown"),
        text: messageText,
        attachments,
        raw: telegramMsg,
        transportMeta: {
          chatType: telegramMsg.chat.type,
        },
      };

      this.handler(msg);
    };
    this.bot.on("message", this.messageListener);
  }

  async stop(): Promise<void> {
    this.authMenuStopped = true;
    this.authMenuLifecycleGeneration += 1;
    this.authFlowManager?.stop();
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    if (this.messageListener) {
      this.bot.removeListener("message", this.messageListener);
      this.messageListener = null;
    }
    await this.bot.stopPolling();
    const configuration = this.authMenuConfiguration;
    if (configuration) {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const deadlinePromise = new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, 1_000);
        if (typeof deadline === "object" && "unref" in deadline) {
          (deadline as NodeJS.Timeout).unref();
        }
      });
      await Promise.race([configuration.catch(() => {}), deadlinePromise]);
      if (deadline !== undefined) {
        clearTimeout(deadline);
      }
      if (this.authMenuConfiguration === configuration) {
        this.authMenuConfiguration = null;
        this.authMenuConfigurationGeneration = null;
      }
    }
    this.started = false;
    logger.info("[telegram] Connector stopped");
  }

  private async configureAuthCommandMenu(
    generation = this.authMenuLifecycleGeneration,
  ): Promise<void> {
    if (
      !this.isAuthMenuConfigurationActive(generation) ||
      !this.authMenuLifecycleManaged ||
      this.authMenuStatePersisted
    ) {
      return;
    }

    if (Date.now() < this.authMenuRetryNotBefore) {
      return;
    }

    if (this.authMenuStateReadFailed) {
      this.authMenuPreviousOwnerUserIds = this.readAuthMenuOwners();
      if (this.authMenuStateReadFailed) {
        this.recordAuthMenuAttempt(true);
        return;
      }
    }

    if (this.authMenuConfiguration) {
      if (this.authMenuConfigurationGeneration === generation) {
        return this.authMenuConfiguration;
      }
      this.authMenuConfiguration = null;
      this.authMenuConfigurationGeneration = null;
    }
    const menuBot = this.authMenuBot;
    if (!menuBot) {
      return;
    }
    const configuration = (async () => {
      let failed = false;
      const currentOwners = new Set(this.authMenuOwnerUserIds);
      for (const ownerUserId of this.authMenuPreviousOwnerUserIds) {
        if (
          currentOwners.has(ownerUserId) ||
          this.authMenuReconciledStaleOwnerUserIds.has(ownerUserId)
        ) {
          continue;
        }
        try {
          await menuBot.deleteMyCommands({
            scope: { type: "chat", chat_id: ownerUserId },
          });
          if (!this.isAuthMenuConfigurationActive(generation)) return;
          this.authMenuReconciledStaleOwnerUserIds.add(ownerUserId);
        } catch (err) {
          if (!this.isAuthMenuConfigurationActive(generation)) return;
          const detail = err instanceof Error ? err.message : String(err);
          if (isPermanentStaleMenuError(err)) {
            this.authMenuReconciledStaleOwnerUserIds.add(ownerUserId);
            logger.warn(
              `[telegram] Stale auth command menu owner ${ownerUserId} is no longer addressable; treating it as reconciled: ${detail}`,
            );
          } else {
            failed = true;
            logger.warn(
              `[telegram] Failed to clear stale auth command menu for owner ${ownerUserId}: ${detail}`,
            );
          }
        }
      }

      if (!this.authFlowManager) {
        if (!this.isAuthMenuConfigurationActive(generation)) return;
        this.persistAuthMenuOwnersIfReconciled();
        this.recordAuthMenuAttempt(failed);
        return;
      }

      const pendingOwnerUserIds = this.authMenuOwnerUserIds.filter(
        (ownerUserId) => !this.authMenuConfiguredOwnerUserIds.has(ownerUserId),
      );
      if (pendingOwnerUserIds.length === 0) {
        if (!this.isAuthMenuConfigurationActive(generation)) return;
        this.persistAuthMenuOwnersIfReconciled();
        this.recordAuthMenuAttempt(failed);
        return;
      }

      let commands: Array<{ command: string; description: string }>;
      try {
        const existingCommands = await menuBot.getMyCommands();
        if (!this.isAuthMenuConfigurationActive(generation)) return;
        const mergedCommands = new Map(
          existingCommands.map((command) => [command.command, command]),
        );
        for (const command of AUTH_MENU_COMMANDS) {
          mergedCommands.set(command.command, { ...command });
        }
        commands = [...mergedCommands.values()];
      } catch (err) {
        if (!this.isAuthMenuConfigurationActive(generation)) return;
        failed = true;
        const detail = err instanceof Error ? err.message : String(err);
        logger.warn(`[telegram] Failed to read the default Telegram command menu: ${detail}`);
        this.persistAuthMenuOwnersIfReconciled();
        this.recordAuthMenuAttempt(failed);
        return;
      }

      if (!this.isAuthMenuConfigurationActive(generation)) return;
      this.persistAuthMenuOwnersIfReconciled();

      for (const ownerUserId of pendingOwnerUserIds) {
        if (!this.isAuthMenuConfigurationActive(generation)) return;
        try {
          await menuBot.setMyCommands(commands, {
            scope: { type: "chat", chat_id: ownerUserId },
          });
          if (!this.isAuthMenuConfigurationActive(generation)) return;
          this.authMenuConfiguredOwnerUserIds.add(ownerUserId);
        } catch (err) {
          failed = true;
          const detail = err instanceof Error ? err.message : String(err);
          logger.warn(
            `[telegram] Failed to configure auth command menu for owner ${ownerUserId}: ${detail}`,
          );
        }
      }
      if (!this.isAuthMenuConfigurationActive(generation)) return;
      this.persistAuthMenuOwnersIfReconciled();
      this.recordAuthMenuAttempt(failed);
    })();
    this.authMenuConfiguration = configuration;
    this.authMenuConfigurationGeneration = generation;
    try {
      await configuration;
    } finally {
      if (this.authMenuConfiguration === configuration) {
        this.authMenuConfiguration = null;
        this.authMenuConfigurationGeneration = null;
      }
    }
  }

  private isAuthMenuConfigurationActive(generation: number): boolean {
    return !this.authMenuStopped && generation === this.authMenuLifecycleGeneration;
  }

  private recordAuthMenuAttempt(failed: boolean): void {
    if (failed || !this.authMenuStatePersisted) {
      this.authMenuFailureCount += 1;
      const retryDelayMs =
        this.authMenuFailureCount === 1
          ? 0
          : Math.min(
              AUTH_MENU_RETRY_DELAY_MS * 2 ** (this.authMenuFailureCount - 2),
              AUTH_MENU_MAX_RETRY_DELAY_MS,
            );
      this.authMenuRetryNotBefore = Date.now() + retryDelayMs;
      return;
    }
    this.authMenuFailureCount = 0;
    this.authMenuRetryNotBefore = 0;
  }

  private readAuthMenuOwners(): readonly number[] {
    this.authMenuStateReadFailed = false;
    let contents: string;
    try {
      contents = fs.readFileSync(this.authMenuOwnersFile, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      this.authMenuStateReadFailed = true;
      logger.error("[telegram] Failed to read auth command menu owner state");
      return [];
    }

    const normalizeOwnerId = (value: unknown): number | null => {
      if (isValidAuthMenuOwnerId(value)) {
        return value;
      }
      if (typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value)) {
        const numericValue = Number(value);
        return isValidAuthMenuOwnerId(numericValue) ? numericValue : null;
      }
      return null;
    };
    const recoverableOwnerIds = (values: readonly unknown[]): readonly number[] =>
      [...new Set(
        values
          .map(normalizeOwnerId)
          .filter((value): value is number => value !== null),
      )];

    try {
      const parsed = JSON.parse(contents) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error("state is not an array");
      }
      const ownerIds = recoverableOwnerIds(parsed);
      if (parsed.some((value) => normalizeOwnerId(value) === null)) {
        this.authMenuStateUnreadable = true;
        logger.warn("[telegram] Auth command menu owner state contains invalid entries");
      }
      return ownerIds;
    } catch {
      this.authMenuStateUnreadable = true;
      logger.error(
        "[telegram] Failed to parse auth command menu owner state; preserving it for forensics",
      );
      return [];
    }
  }

  private persistAuthMenuOwnersIfReconciled(): void {
    if (this.authMenuStatePersisted) {
      return;
    }
    const currentOwners = new Set(this.authMenuOwnerUserIds);
    const hasUnreconciledStaleOwners = this.authMenuPreviousOwnerUserIds.some(
      (ownerUserId) =>
        !currentOwners.has(ownerUserId) &&
        !this.authMenuReconciledStaleOwnerUserIds.has(ownerUserId),
    );

    const durableOwners = hasUnreconciledStaleOwners
      ? [...new Set([...this.authMenuPreviousOwnerUserIds, ...this.authMenuOwnerUserIds])]
      : [...this.authMenuOwnerUserIds];
    const configuredOwners = this.authMenuOwnerUserIds.filter((ownerUserId) =>
      this.authMenuConfiguredOwnerUserIds.has(ownerUserId),
    );
    const fullyConfigured = configuredOwners.length === this.authMenuOwnerUserIds.length;

    try {
      fs.mkdirSync(AUTH_MENU_OWNERS_DIR, { recursive: true, mode: 0o700 });
      const temporaryFile = this.authMenuOwnersFile + ".tmp";
      fs.writeFileSync(
        temporaryFile,
        JSON.stringify(durableOwners) + "\n",
        { mode: 0o600 },
      );
      if (this.authMenuStateUnreadable) {
        this.archiveCorruptOwnerState();
        this.authMenuStateUnreadable = false;
      }
      fs.renameSync(temporaryFile, this.authMenuOwnersFile);
      this.authMenuStatePersisted = fullyConfigured && !hasUnreconciledStaleOwners;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn(`[telegram] Failed to persist auth command menu owners: ${detail}`);
    }
  }

  private archiveCorruptOwnerState(): void {
    try {
      fs.copyFileSync(
        this.authMenuOwnersFile,
        this.authMenuOwnersFile + ".corrupt-" + Date.now(),
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }

  private async verifyProviderAuth(provider: AuthProvider): Promise<boolean> {
    if (provider === "codex") {
      return fs.existsSync("/home/node/.codex/auth.json");
    }

    try {
      const { stdout } = await execFileWithTimeout(
        "claude",
        ["auth", "status", "--json"],
        {
          cwd: "/home/node",
          env: AUTH_ENV,
          maxBuffer: 256 * 1024,
        },
        15_000,
      );
      const status = JSON.parse(stdout) as { loggedIn?: unknown };
      if (typeof status.loggedIn !== "boolean") {
        throw Object.assign(
          new Error("provider authentication status could not be read"),
          { probeFailed: true },
        );
      }
      return status.loggedIn;
    } catch (err) {
      const providerError = err as {
        timedOut?: unknown;
        stdout?: unknown;
      };
      if (providerError.timedOut === true) {
        throw Object.assign(
          new Error("provider authentication verification timed out"),
          { timedOut: true },
        );
      }
      if (typeof providerError.stdout === "string") {
        const loggedIn = this.loggedInFromProbeStdout(providerError.stdout);
        if (loggedIn === false) {
          return false;
        }
      }
      throw Object.assign(
        err instanceof Error
          ? err
          : new Error("provider authentication status could not be read"),
        { probeFailed: true },
      );
    }
  }

  private loggedInFromProbeStdout(stdout: string): boolean | null {
    try {
      const status = JSON.parse(stdout) as { loggedIn?: unknown };
      return typeof status.loggedIn === "boolean" ? status.loggedIn : null;
    } catch {
      return null;
    }
  }

  getCapabilities(): ConnectorCapabilities {
    return this.capabilities;
  }

  getHealth(): ConnectorHealth {
    return {
      status: this.lastError ? "error" : this.started ? "running" : "stopped",
      detail: this.lastError ?? undefined,
      capabilities: this.capabilities,
    };
  }

  reconstructTarget(replyContext: ReplyContext): Target {
    return {
      channel: String(replyContext.chatId ?? ""),
      messageTs: replyContext.messageId != null ? String(replyContext.messageId) : undefined,
      replyContext,
    };
  }

  private async safeSend(
    chatId: string,
    text: string,
    opts: SendMessageOptions = {},
    useMarkdown = true,
  ): Promise<string | undefined> {
    const sendOptions = useMarkdown ? { parse_mode: "Markdown", ...opts } : opts;
    try {
      const result = await this.bot.sendMessage(chatId, text, sendOptions);
      return String(result.message_id);
    } catch (err) {
      if (!useMarkdown) {
        if (!isRetryableTelegramSendError(err)) {
          logger.error(`[telegram] Plain-text send failed: ${err}`);
          return undefined;
        }
        logger.warn(`[telegram] Plain-text transport failed, retrying: ${err}`);
        await new Promise((resolve) => setTimeout(resolve, AUTH_SEND_RETRY_DELAY_MS));
        try {
          const result = await this.bot.sendMessage(chatId, text, opts);
          return String(result.message_id);
        } catch (retryErr) {
          logger.error(`[telegram] Plain-text send failed: ${retryErr}`);
          return undefined;
        }
      }
      // On parse error, retry without Markdown formatting. Strip the markers we
      // added during conversion so users don't see literal asterisks/underscores.
      logger.warn(`[telegram] Send failed with Markdown, retrying as plain text: ${err}`);
      try {
        const result = await this.bot.sendMessage(chatId, stripTelegramMarkdown(text), opts);
        return String(result.message_id);
      } catch (retryErr) {
        logger.error(`[telegram] Send failed: ${retryErr}`);
        return undefined;
      }
    }
  }

  async sendMessage(target: Target, text: string): Promise<string | undefined> {
    if (!text || !text.trim()) return undefined;
    const chunks = formatResponse(text);
    let lastMessageId: string | undefined;
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const id = await this.safeSend(target.channel, chunk);
      if (id) lastMessageId = id;
    }
    return lastMessageId;
  }

  async replyMessage(target: Target, text: string): Promise<string | undefined> {
    if (!text || !text.trim()) return undefined;
    const replyToId =
      target.replyContext?.messageId != null
        ? Number(target.replyContext.messageId)
        : undefined;
    const opts: SendMessageOptions = {};
    if (replyToId) {
      opts.reply_parameters = { message_id: replyToId };
    }
    const chunks = formatResponse(text);
    let lastMessageId: string | undefined;
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const id = await this.safeSend(target.channel, chunk, opts);
      if (id) lastMessageId = id;
    }
    return lastMessageId;
  }

  async setTypingStatus(channelId: string, _threadTs: string | undefined, status: string): Promise<void> {
    const existing = this.typingIntervals.get(channelId);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(channelId);
    }
    if (!status) return;
    try {
      await this.bot.sendChatAction(channelId, "typing");
      // Telegram typing expires after ~5s — refresh every 4s
      const interval = setInterval(async () => {
        try {
          await this.bot.sendChatAction(channelId, "typing");
        } catch { /* non-fatal */ }
      }, 4_000);
      this.typingIntervals.set(channelId, interval);
    } catch {
      // non-fatal
    }
  }

  async addReaction(_target: Target, _emoji: string): Promise<void> {
    // Telegram Bot API reaction support is limited; no-op for now
  }

  async removeReaction(_target: Target, _emoji: string): Promise<void> {
    // No-op
  }

  async editMessage(target: Target, text: string): Promise<void> {
    if (!target.messageTs) return;
    if (!text || !text.trim()) return;
    // Apply the same markdown conversion as sends; edits are single-message,
    // so keep only the first chunk (truncated to the platform limit).
    const [converted] = formatResponse(text);
    await this.bot.editMessageText(converted, {
      chat_id: target.channel,
      message_id: Number(target.messageTs),
      parse_mode: "Markdown",
    });
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
  }
}
