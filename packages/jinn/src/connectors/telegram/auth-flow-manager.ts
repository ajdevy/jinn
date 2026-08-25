import {
  DEFAULT_VERIFY_TIMEOUT_SECONDS,
  hasAuthPayload,
  isAuthCommandPrefix,
  parseAuthCommand,
} from "./auth-flow-parser.js";
import { AuthFlowProcessManager } from "./auth-flow-process.js";
import { ProviderStatusVerifier } from "./auth-flow-status.js";
import type {
  AuthCommand,
  AuthFlowManagerOptions,
  AuthMessage,
} from "./auth-flow-types.js";

const DEFAULT_ENV = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/home/node",
  CLAUDE_CONFIG_DIR: "/home/node/.claude",
  CODEX_HOME: "/home/node/.codex",
};

function isBareAuthCommand(command: AuthCommand | null): boolean {
  return command?.kind === "start" || command?.kind === "status" || command?.kind === "cancel";
}

export class AuthFlowManager {
  private readonly owners: ReadonlySet<number>;
  private readonly send: AuthFlowManagerOptions["send"];
  private readonly remove: AuthFlowManagerOptions["deleteMessage"];
  private readonly logger: AuthFlowManagerOptions["logger"];
  private readonly env: Record<string, string>;
  private readonly verifier: ProviderStatusVerifier;
  private readonly process: AuthFlowProcessManager;
  private readonly scrubNonOwners: boolean;

  constructor(options: AuthFlowManagerOptions) {
    this.owners = new Set(options.ownerUserIds);
    this.send = options.send;
    this.remove = options.deleteMessage;
    this.logger = options.logger;
    this.env = options.providerEnv ?? DEFAULT_ENV;
    this.scrubNonOwners = options.deleteSensitiveInputFromNonOwners === true;
    const timeout = options.verifyTimeoutSeconds && options.verifyTimeoutSeconds > 0 ? options.verifyTimeoutSeconds : DEFAULT_VERIFY_TIMEOUT_SECONDS;
    this.verifier = new ProviderStatusVerifier({ clock: options.clock, verifyAuth: options.verifyAuth, timeoutSeconds: timeout, logger: options.logger });
    this.process = new AuthFlowProcessManager({ clock: options.clock, send: options.send, spawnPty: options.spawnPty, verifier: this.verifier, logger: options.logger, flowTtlSeconds: options.flowTtlSeconds });
  }

  async handleMessage(message: AuthMessage): Promise<boolean> {
    const raw = message.text.trim();
    if (!isAuthCommandPrefix(raw)) return false;
    const command = parseAuthCommand(message.text);
    const ownerId = this.ownerId(message.userId);
    const warning = await this.scrubPayload(message, command, ownerId);
    if (ownerId === null) return true;
    if (message.chatType !== "private") {
      await this.safeSend(message.chatId, "Authentication commands are available only in a private chat." + (warning ? "\n" + warning : ""));
      return true;
    }
    if (!command) {
      await this.safeSend(message.chatId, "Unsupported authentication command." + (warning ? "\n" + warning : ""));
      return true;
    }
    await this.dispatch(ownerId, message, command, warning);
    return true;
  }

  stop(): void {
    this.process.stop();
  }

  private async dispatch(ownerId: number, message: AuthMessage, command: AuthCommand, warning: string): Promise<void> {
    if (command.kind === "start") return void (await this.process.start(ownerId, command.provider, message.chatId, this.env));
    if (command.kind === "status") return void (await this.status(ownerId, message.chatId));
    if (command.kind === "cancel") return void (await this.process.cancel(ownerId, message.chatId));
    if (command.kind === "input") {
      await this.process.writeCode(ownerId, command.code, message.chatId);
      if (warning) await this.safeSend(message.chatId, warning);
      return;
    }
    await this.safeSend(message.chatId, "Unsupported authentication command. One-time codes must match the short-code format; tokens are not accepted." + (warning ? "\n" + warning : ""));
  }

  private async status(ownerId: number, chatId: AuthMessage["chatId"]): Promise<void> {
    const providers = ["claude", "codex"] as const;
    const active = this.process.activeStatus(ownerId);
    if (providers.some((provider) => !this.verifier.hasFresh(provider))) await this.safeSend(chatId, active + "\nChecking authentication status...");
    const statuses = await Promise.all(providers.map(async (provider) => {
      const result = await this.verifier.get(provider);
      const state = result.verified ? "authenticated" : result.timedOut ? "verification timed out" : result.unavailable ? "status unavailable" : "not authenticated";
      return `${provider[0].toUpperCase() + provider.slice(1)}: ${state}.`;
    }));
    await this.safeSend(chatId, this.process.activeStatus(ownerId) + "\n" + statuses.join("\n"));
  }

  private ownerId(value: number | string): number | null {
    const id = typeof value === "number" ? value : Number(value);
    return Number.isSafeInteger(id) && this.owners.has(id) ? id : null;
  }

  private async scrubPayload(message: AuthMessage, command: AuthCommand | null, ownerId: number | null): Promise<string> {
    if (!hasAuthPayload(message.text.trim()) || isBareAuthCommand(command) || (ownerId === null && !this.scrubNonOwners)) return "";
    try {
      if (message.messageId !== undefined) await this.remove(message.chatId, message.messageId);
      return "";
    } catch {
      this.logger.warn?.("[telegram-auth] unable to delete sensitive auth message");
      return "Warning: the message could not be deleted. Remove it manually.";
    }
  }

  private async safeSend(chatId: AuthMessage["chatId"], text: string): Promise<void> {
    try { await this.send(chatId, text); } catch { this.logger.warn?.("[telegram-auth] unable to send auth update"); }
  }
}
