import { execFile, spawn } from "node:child_process";
import type { Target, TelegramConnectorConfig } from "../../shared/types.js";
import { logger as defaultLogger } from "../../shared/logger.js";
import {
  AuthFlowManager,
  type AuthProvider,
  type AuthFlowManagerOptions,
  type AuthMessage,
  type SpawnPty,
} from "./auth-flow.js";

const AUTH_VERIFY_TIMEOUT_MS = 15_000;
const AUTH_KILL_GRACE_MS = 2_000;
const AUTH_LOGIN_PROMPT =
  "Provider authentication is required. Check `/auth_status`, then use `/auth_claude` or `/auth_codex` to sign in.";
const AUTHENTICATION_FAILURE_PATTERN =
  /\binteractive turn failed:\s*authentication_failed\b|\b(?:claude|codex)(?:\s+cli)?\s+(?:authentication failed|is not authenticated|is not logged in)\b|\b(?:codex|claude)\s+(?:login required|login needed)\b/i;
const AUTH_VERIFY_ENV = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/home/node",
  CLAUDE_CONFIG_DIR: "/home/node/.claude",
  CODEX_HOME: "/home/node/.codex",
};

type AuthConfig = NonNullable<TelegramConnectorConfig["telegramAuth"]>;

export interface TelegramAuthDependencies {
  send: AuthFlowManagerOptions["send"];
  deleteMessage: AuthFlowManagerOptions["deleteMessage"];
  spawnPty: SpawnPty;
}

export function createTelegramAuthManager(
  config: AuthConfig,
  dependencies: TelegramAuthDependencies,
): AuthFlowManager {
  return new AuthFlowManager({
    ownerUserIds: config.ownerUserIds ?? [],
    flowTtlSeconds: config.flowTtlSeconds,
    clock: {
      now: () => Date.now(),
      setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    send: dependencies.send,
    deleteMessage: dependencies.deleteMessage,
    spawnPty: dependencies.spawnPty,
    verifyAuth: getProviderAuthStatus,
    getAuthStatus: getProviderAuthStatus,
    logger: defaultLogger,
  });
}

export async function handleTelegramAuthMessage(
  manager: AuthFlowManager | undefined,
  telegramMsg: any,
  userId: number | undefined,
  text: string,
): Promise<boolean> {
  if (!manager) return false;
  const message: AuthMessage = {
    userId: userId ?? "unknown",
    chatType: telegramMsg.chat.type,
    chatId: telegramMsg.chat.id,
    messageId: telegramMsg.message_id,
    text,
  };
  return manager.handleMessage(message);
}

export function buildTelegramAuthReply(
  target: Target,
  text: string,
  manager: AuthFlowManager | undefined,
  ownerUserIds: ReadonlySet<number>,
): string {
  return manager && isOwnerPrivateAuthTarget(target, ownerUserIds) && AUTHENTICATION_FAILURE_PATTERN.test(text)
    ? `${text}\n\n${AUTH_LOGIN_PROMPT}`
    : text;
}

function isOwnerPrivateAuthTarget(
  target: Target,
  ownerUserIds: ReadonlySet<number>,
): boolean {
  const context = target.replyContext;
  if (!context || context.chatType !== "private") return false;
  const rawUserId = context.userId;
  const userId =
    typeof rawUserId === "number"
      ? rawUserId
      : typeof rawUserId === "string"
        ? Number(rawUserId)
        : NaN;
  return Number.isSafeInteger(userId) && ownerUserIds.has(userId);
}

function getProviderAuthStatus(provider: AuthProvider): Promise<boolean> {
  return provider === "claude" ? verifyClaudeAuth() : verifyCodexAuth();
}

function verifyClaudeAuth(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["auth", "status", "--json"],
      { env: AUTH_VERIFY_ENV, timeout: AUTH_VERIFY_TIMEOUT_MS, maxBuffer: 16 * 1024 },
      (error, stdout) => {
        if (error) return resolve(false);
        try {
          resolve(JSON.parse(stdout)?.loggedIn === true);
        } catch {
          resolve(false);
        }
      },
    );
  });
}

function verifyCodexAuth(): Promise<boolean> {
  const child = spawn("codex", ["login", "status"], {
    env: AUTH_VERIFY_ENV,
    stdio: "ignore",
  });
  return waitForCodexStatus(child);
}

function waitForCodexStatus(child: ReturnType<typeof spawn>): Promise<boolean> {
  return new Promise((resolve) => {
    let authTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const settle = (authenticated: boolean) => {
      if (settled) return;
      settled = true;
      cleanupCodexStatusChild(child, listeners, [authTimer, killTimer, finalTimer]);
      resolve(authenticated);
    };
    const forceKill = () => {
      killCodexStatusChild(child, "SIGKILL");
      finalTimer = setTimeout(() => settle(false), AUTH_KILL_GRACE_MS);
    };
    const terminate = () => {
      killCodexStatusChild(child, "SIGTERM");
      killTimer = setTimeout(forceKill, AUTH_KILL_GRACE_MS);
    };
    const listeners = {
      error: () => settle(false),
      exit: (code: number | null) => settle(code === 0),
      close: (code: number | null) => settle(code === 0),
    };
    child.once("error", listeners.error);
    child.once("exit", listeners.exit);
    child.once("close", listeners.close);
    authTimer = setTimeout(terminate, AUTH_VERIFY_TIMEOUT_MS);
  });
}

function killCodexStatusChild(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  try {
    child.kill(signal);
  } catch {
    // The process may have exited between the timeout and the kill request.
  }
}

function cleanupCodexStatusChild(
  child: ReturnType<typeof spawn>,
  listeners: {
    error: () => void;
    exit: (code: number | null) => void;
    close: (code: number | null) => void;
  },
  timers: Array<ReturnType<typeof setTimeout> | undefined>,
): void {
  for (const timer of timers) if (timer !== undefined) clearTimeout(timer);
  child.removeListener("error", listeners.error);
  child.removeListener("exit", listeners.exit);
  child.removeListener("close", listeners.close);
}
