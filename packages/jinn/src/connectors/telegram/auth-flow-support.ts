export {
  type AuthChatId,
  type AuthClock,
  type AuthCommand,
  type AuthFlowManagerOptions,
  type AuthInputSource,
  type AuthLogger,
  type AuthMessage,
  type AuthProvider,
  type AuthPty,
  type AuthSpawnOptions,
  type SpawnPty,
} from "./auth-flow-types.js";
import type {
  AuthChatId,
  AuthClock,
  AuthCommand,
  AuthProvider,
  AuthPty,
} from "./auth-flow-types.js";
import { isAuthCode, parseAuthInput } from "./auth-flow-input.js";

export const AUTH_PROVIDERS = ["claude", "codex"] as const satisfies readonly AuthProvider[];

const MAX_OUTPUT_BYTES = 64 * 1024;
export const AUTH_PREFIX_PATTERN =
  /^\/auth(?:_[a-z0-9-]+(?:@[A-Za-z0-9_]+)?|@[A-Za-z0-9_]+)?(?:[\s=:]|$)/i;
export const SENSITIVE_INPUT_PATTERN =
  /^\/auth(?:_[a-z0-9-]+(?:@[A-Za-z0-9_]+)?|@[A-Za-z0-9_]+)?(?:\s+\S|[=:]\s*\S)/i;
const ANSI_PATTERN = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export const defaultClock: AuthClock = {
  now: () => Date.now(),
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function providerLabel(provider: AuthProvider): string {
  return provider === "claude" ? "Claude" : "Codex";
}

export function parseAuthCommand(text: string): AuthCommand | null {
  const normalized = text.trim();
  if (!normalized || !AUTH_PREFIX_PATTERN.test(normalized)) {
    return null;
  }
  if (/\r|\n/.test(normalized)) {
    return { kind: "rejected" };
  }
  return parseMenuCommand(normalized) ?? parseLegacyCommand(normalized) ?? { kind: "rejected" };
}

function parseMenuCommand(normalized: string): AuthCommand | null {
  const menu = normalized.match(
    /^\/auth_([a-z-]+)(?:@[A-Za-z0-9_]+)?(?:(?:\s+|[=:]\s*)(\S+))?$/i,
  );
  return menu ? menuCommand(menu[1].toLowerCase(), menu[2]) : null;
}

function parseLegacyCommand(normalized: string): AuthCommand | null {
  const legacy = normalized.match(/^\/auth(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/i);
  if (!legacy) return null;
  const args = legacy[1]?.trim().split(/\s+/) ?? [];
  if (args.length === 1) return parseSingleArgCommand(args[0].toLowerCase());
  if (args.length === 2 && args[0].toLowerCase() === "input") {
    return parseAuthInput(args[1]) ?? { kind: "rejected" };
  }
  return { kind: "rejected" };
}

function menuCommand(action: string, value: string | undefined): AuthCommand {
  if (action === "input") {
    return value ? parseAuthInput(value) ?? { kind: "rejected" } : { kind: "rejected" };
  }
  const command = {
    claude: { kind: "start", provider: "claude" },
    codex: { kind: "start", provider: "codex" },
    status: { kind: "status" },
    cancel: { kind: "cancel" },
  }[action] as AuthCommand | undefined;
  return command && value === undefined ? command : { kind: "rejected" };
}

function parseSingleArgCommand(action: string): AuthCommand {
  switch (action) {
    case "claude":
      return { kind: "start", provider: "claude" };
    case "codex":
      return { kind: "start", provider: "codex" };
    case "status":
      return { kind: "status" };
    case "cancel":
      return { kind: "cancel" };
    default:
      return { kind: "rejected" };
  }
}

export function providerArgs(provider: AuthProvider): string[] {
  return provider === "claude"
    ? ["auth", "login", "--claudeai"]
    : ["login", "--device-auth"];
}

export function providerEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    PATH: env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/home/node",
    CLAUDE_CONFIG_DIR: "/home/node/.claude",
    CODEX_HOME: "/home/node/.codex",
  };
}

export function flowHasActiveDiscovery(flow: ActiveFlow): boolean {
  return Boolean(
    (flow.discoveredUrl && !flow.urlSent) ||
      (flow.discoveredCode && !flow.codeSent),
  );
}

export function discoveryLines(flow: ActiveFlow): string[] {
  const lines = ["Continue authentication:"];
  if (flow.discoveredUrl && !flow.urlSent) {
    flow.urlSent = true;
    lines.push(flow.discoveredUrl);
  }
  if (flow.discoveredCode && !flow.codeSent) {
    flow.codeSent = true;
    lines.push("Device code: " + flow.discoveredCode);
  }
  return lines;
}

function activeProviderStatusLine(providers: AuthProvider[]): string | null {
  if (providers.length === 0) {
    return null;
  }
  return (
    "Active authentication flows: " +
    providers.map((provider) => providerLabel(provider)).join(", ") +
    "."
  );
}

export function validDurationSeconds(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export function redactAuthOutput(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL REDACTED]")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [TOKEN REDACTED]")
    .replace(
      /\b(?:access|refresh|oauth)[_-]?token\s*[:=]\s*[^\s,;]+/gi,
      "[TOKEN REDACTED]",
    )
    .replace(
      /\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[TOKEN REDACTED]",
    )
    .replace(/\b[A-Z0-9][A-Z0-9-]{3,31}\b/g, "[CODE REDACTED]");
}

export function extractDiscovery(text: string): { url?: string; code?: string } {
  const normalized = text.replace(ANSI_PATTERN, "");
  const urlMatch = normalized.match(/https:\/\/[^\s"'<>\x60]+/i);
  const url = urlMatch?.[0]?.replace(/[.,!?;:)\]}]+$/g, "");

  const codeMatch =
    normalized.match(
      /(?:device\s+code|user\s+code|code)\s*[:=]?\s*([A-Z0-9][A-Z0-9-]{3,31})\b/i,
    ) ?? normalized.match(/(?:device_code|user_code)=([A-Z0-9][A-Z0-9-]{3,31})\b/i);
  const code = codeMatch?.[1] && isAuthCode(codeMatch[1]) ? codeMatch[1] : undefined;

  return { url, code };
}

export function appendBoundedText(current: string, data: string, maxBytes: number): string {
  const bytes = Buffer.concat([Buffer.from(current, "utf8"), Buffer.from(data, "utf8")]);
  const kept =
    bytes.length > maxBytes
      ? bytes.subarray(bytes.length - maxBytes)
      : bytes;
  return kept.toString("utf8");
}

export function appendOutput(current: string, data: string): string {
  return appendBoundedText(current, data, MAX_OUTPUT_BYTES);
}

export type FlowKey = string;

export function flowKey(ownerId: number, provider: AuthProvider): FlowKey {
  return ownerId + ":" + provider;
}

export interface ActiveFlow {
  ownerId: number;
  key: FlowKey;
  provider: AuthProvider;
  chatId: AuthChatId;
  pty: AuthPty;
  output: string;
  discoveryTail: string;
  timer: unknown;
  discoveredUrl?: string;
  discoveredCode?: string;
  urlSent: boolean;
  codeSent: boolean;
  discoveryScheduled: boolean;
  invalidated: boolean;
  dataSubscription?: { dispose?: () => void };
  exitSubscription?: { dispose?: () => void };
}

export function createFlow(options: {
  ownerId: number;
  key: FlowKey;
  provider: AuthProvider;
  chatId: AuthChatId;
  pty: AuthPty;
}): ActiveFlow {
  return {
    ...options,
    output: "",
    discoveryTail: "",
    timer: undefined,
    urlSent: false,
    codeSent: false,
    discoveryScheduled: false,
    invalidated: false,
  };
}

export function subscriptionObject(
  subscription: { dispose?: () => void } | void,
): { dispose?: () => void } | undefined {
  return subscription && typeof subscription === "object"
    ? subscription
    : undefined;
}

export function statusLines(
  activeProviders: AuthProvider[],
  statuses: Array<{ provider: AuthProvider; authenticated: boolean }>,
): string[] {
  const activeLine = activeProviderStatusLine(activeProviders);
  const lines = activeLine ? [activeLine] : [];
  lines.push(
    ...statuses.map(({ provider, authenticated }) =>
      statusLine(provider, authenticated),
    ),
  );
  return lines;
}



export function statusLine(provider: AuthProvider, authenticated: boolean): string {
  const label = providerLabel(provider);
  return authenticated
    ? label + " is authenticated."
    : label + " is not authenticated. Use /auth_" + provider + " to sign in.";
}
