import { execFile } from "node:child_process";
import fs from "node:fs";
import * as pty from "node-pty";
import TelegramBot from "node-telegram-bot-api";
import { AuthFlowManager } from "./auth-flow.js";
import type { AuthLogger, AuthMessage, AuthProvider } from "./auth-flow-types.js";
import { TelegramAuthMenu } from "./telegram-auth-menu.js";
import { TelegramAuthMenuState } from "./telegram-auth-menu-state.js";

const AUTH_ENV = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/home/node",
  CLAUDE_CONFIG_DIR: "/home/node/.claude",
  CODEX_HOME: "/home/node/.codex",
};

function resolveOwnerIds(configured: readonly number[], allowFrom: Set<number> | null, logger: AuthLogger): number[] {
  const valid = configured.filter((id) => Number.isSafeInteger(id) && id > 0);
  for (const id of configured) {
    if (!Number.isSafeInteger(id) || id <= 0) logger.warn?.(`[telegram] Ignoring invalid telegramAuth owner user id: ${String(id)}`);
  }
  for (const id of valid) {
    if (allowFrom && !allowFrom.has(id)) logger.warn?.(`[telegram] Excluding telegramAuth owner not present in allowFrom: ${id}`);
  }
  return [...new Set(valid.filter((id) => !allowFrom || allowFrom.has(id)))];
}

function loggedOutFromProbe(stdout: unknown): boolean {
  if (typeof stdout !== "string") return false;
  try {
    const status = JSON.parse(stdout) as { loggedIn?: unknown };
    return status.loggedIn === false;
  } catch {
    return false;
  }
}

function execFileWithTimeout(file: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = execFile(file, args, { cwd: "/home/node", env: AUTH_ENV, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(Object.assign(error instanceof Error ? error : new Error(String(error)), { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(Object.assign(new Error("provider authentication verification timed out"), { timedOut: true }));
    }, timeoutMs);
  });
}

export class TelegramAuthIntegration {
  private readonly manager?: AuthFlowManager;
  private readonly menu?: TelegramAuthMenu;

  constructor(options: {
    botToken: string;
    connectorId: string;
    allowFrom: Set<number> | null;
    telegramAuth: { enabled?: boolean; ownerUserIds?: number[]; flowTtlSeconds?: number } | undefined;
    send: (chatId: number | string, text: string) => void | Promise<void>;
    deleteMessage: (chatId: number | string, messageId: number | string) => void | Promise<void>;
    logger: AuthLogger;
  }) {
    const state = new TelegramAuthMenuState(options.connectorId, options.logger);
    const configured = options.telegramAuth?.ownerUserIds ?? [];
    const owners = resolveOwnerIds(configured, options.allowFrom, options.logger);
    if (options.telegramAuth?.enabled) {
      this.manager = new AuthFlowManager({
        ownerUserIds: owners,
        flowTtlSeconds: options.telegramAuth.flowTtlSeconds,
        clock: { now: () => Date.now(), setTimeout: (handler, delay) => setTimeout(handler, delay), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
        send: options.send,
        deleteMessage: options.deleteMessage,
        spawnPty: (file, args, spawnOptions) => pty.spawn(file, args, spawnOptions),
        providerEnv: AUTH_ENV,
        verifyAuth: (provider) => this.verifyProviderAuth(provider),
        deleteSensitiveInputFromNonOwners: true,
        logger: options.logger,
      });
    }
    const managed = options.telegramAuth !== undefined || state.previousOwnerIds.length > 0 || state.stateUnreadable || state.stateReadFailed;
    if (managed) {
      const menuBot = new TelegramBot(options.botToken, { polling: false, request: { timeoutMs: 10_000 } });
      this.menu = new TelegramAuthMenu({ bot: menuBot, state, ownerIds: owners, hasAuthFlow: Boolean(this.manager), logger: options.logger });
    }
  }

  start(): void { this.menu?.start(); }
  ensureMenu(): void { this.menu?.ensure(); }
  async handle(message: AuthMessage): Promise<boolean> { return this.manager ? this.manager.handleMessage(message) : false; }
  async stop(): Promise<void> { this.manager?.stop(); await this.menu?.stop(); }

  private async verifyProviderAuth(provider: AuthProvider): Promise<boolean> {
    if (provider === "codex") return fs.existsSync("/home/node/.codex/auth.json");
    try {
      const { stdout } = await execFileWithTimeout("claude", ["auth", "status", "--json"], 15_000);
      const status = JSON.parse(stdout) as { loggedIn?: unknown };
      if (typeof status.loggedIn !== "boolean") throw Object.assign(new Error("provider authentication status could not be read"), { probeFailed: true });
      return status.loggedIn;
    } catch (error) {
      const failure = error as { timedOut?: unknown; stdout?: unknown };
      if (failure.timedOut === true) throw Object.assign(new Error("provider authentication verification timed out"), { timedOut: true });
      if (loggedOutFromProbe(failure.stdout)) return false;
      throw Object.assign(error instanceof Error ? error : new Error("provider authentication status could not be read"), { probeFailed: true });
    }
  }
}
