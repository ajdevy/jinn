import type { ActiveFlow, AuthCommand, AuthProvider } from "./auth-flow-types.js";

export const DEFAULT_FLOW_TTL_SECONDS = 600;
export const DEFAULT_VERIFY_TIMEOUT_SECONDS = 30;
export const MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_DISCOVERY_TAIL_BYTES = 4096;

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{3,31}$/;
const AUTH_SUBCOMMAND_PATTERN =
  "(?:claude|codex|status|cancel|input|token|access[-_]token|refresh[-_]token|oauth[-_]token|api[-_]key|apikey)";
const AUTH_PREFIX_PATTERN = new RegExp(
  `^\\/auth(?:_${AUTH_SUBCOMMAND_PATTERN}(?:@[A-Za-z0-9_]+)?|@[A-Za-z0-9_]+)?(?:[\\s=:]|$)`,
  "i",
);
const AUTH_PAYLOAD_PATTERN = new RegExp(
  `^\\/auth(?:_${AUTH_SUBCOMMAND_PATTERN}(?:@[A-Za-z0-9_]+)?|@[A-Za-z0-9_]+)?(?:\\s+\\S|[=:]\\s*\\S)`,
  "i",
);
const ANSI_PATTERN = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function isAuthCommandPrefix(text: string): boolean {
  return AUTH_PREFIX_PATTERN.test(text);
}

export function hasAuthPayload(text: string): boolean {
  return AUTH_PAYLOAD_PATTERN.test(text);
}

function isAuthCode(value: string): boolean {
  return CODE_PATTERN.test(value);
}

export function providerLabel(provider: AuthProvider): string {
  return provider === "claude" ? "Claude" : "Codex";
}

const LEGACY_SINGLE_AUTH_COMMANDS: Readonly<Record<string, AuthCommand>> = {
  claude: { kind: "start", provider: "claude" },
  codex: { kind: "start", provider: "codex" },
  status: { kind: "status" },
  cancel: { kind: "cancel" },
};

export function parseAuthCommand(text: string): AuthCommand | null {
  const normalized = text.trim();
  if (!normalized || /\r|\n/.test(normalized)) return null;
  const menu = parseAuthMenuCommand(normalized);
  return menu ?? parseLegacyAuthCommand(normalized);
}

function parseLegacyAuthCommand(normalized: string): AuthCommand | null {
  const match = normalized.match(/^\/auth(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/i);
  if (!match) return null;
  const args = match[1]?.trim().split(/\s+/) ?? [];
  if (args.length === 1) return LEGACY_SINGLE_AUTH_COMMANDS[args[0].toLowerCase()] ?? { kind: "rejected" };
  if (args.length === 2) {
    return args[0].toLowerCase() === "input" && isAuthCode(args[1])
      ? { kind: "input", code: args[1] }
      : { kind: "rejected" };
  }
  return { kind: "rejected" };
}

function parseAuthMenuCommand(normalized: string): AuthCommand | null {
  const input = normalized.match(/^\/auth_input(?:@[A-Za-z0-9_]+)?(?:\s+|[=:]\s*)(\S+)$/i);
  if (input) return isAuthCode(input[1]) ? { kind: "input", code: input[1] } : { kind: "rejected" };
  if (/^\/auth_input(?:@[A-Za-z0-9_]+)?$/i.test(normalized)) return { kind: "rejected" };
  if (/^\/auth_(?:token|access[-_]token|refresh[-_]token|oauth[-_]token|api[-_]key|apikey)(?:@[A-Za-z0-9_]+)?(?:\s+|[=:])/i.test(normalized)) {
    return { kind: "rejected" };
  }
  const menu = normalized.match(/^\/auth_(claude|codex|status|cancel)(?:@[A-Za-z0-9_]+)?$/i);
  if (!menu) return null;
  const action = menu[1].toLowerCase();
  if (action === "claude" || action === "codex") return { kind: "start", provider: action };
  return action === "status" ? { kind: "status" } : { kind: "cancel" };
}

export function redactAuthOutput(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL REDACTED]")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [TOKEN REDACTED]")
    .replace(/\b(?:access|refresh|oauth)[_-]?token\s*[:=]\s*[^\s,;]+/gi, "[TOKEN REDACTED]")
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[TOKEN REDACTED]")
    .replace(/\b[A-Z0-9][A-Z0-9-]{3,31}\b/g, "[CODE REDACTED]");
}

export function extractDiscovery(text: string): { url?: string; code?: string } {
  const normalized = text.replace(ANSI_PATTERN, "");
  const url = normalized.match(/https:\/\/[^\s"'<>\x60]+/i)?.[0]?.replace(/[.,!?;:)\]}]+$/g, "");
  const codeMatch = normalized.match(/(?:device\s+code|user\s+code|code)\s*[:=]?\s*([A-Z0-9][A-Z0-9-]{3,31})\b/i) ?? normalized.match(/(?:device_code|user_code)=([A-Z0-9][A-Z0-9-]{3,31})\b/i);
  const code = codeMatch?.[1] && isAuthCode(codeMatch[1]) ? codeMatch[1] : undefined;
  return { url, code };
}

export function appendBoundedText(current: string, data: string, maxBytes: number): string {
  const bytes = Buffer.concat([Buffer.from(current), Buffer.from(data)]);
  return (bytes.length > maxBytes ? bytes.subarray(bytes.length - maxBytes) : bytes).toString("utf8");
}

export function appendOutput(current: string, data: string): string {
  return appendBoundedText(current, data, MAX_OUTPUT_BYTES);
}

export function flowKey(ownerId: number, provider: AuthProvider): string {
  return `${ownerId}:${provider}`;
}

export function updateDiscovery(flow: ActiveFlow, data: string): void {
  const discovery = extractDiscovery(flow.discoveryTail + data);
  if (discovery.url && !flow.discoveredUrl) flow.discoveredUrl = discovery.url;
  if (discovery.code && !flow.discoveredCode) flow.discoveredCode = discovery.code;
  flow.discoveryTail = appendBoundedText(flow.discoveryTail, data, MAX_DISCOVERY_TAIL_BYTES);
}

export function discoveryMessageLines(flow: ActiveFlow): string[] {
  const discovery = extractDiscovery(flow.output);
  if (discovery.url && !flow.discoveredUrl) flow.discoveredUrl = discovery.url;
  if (discovery.code && !flow.discoveredCode) flow.discoveredCode = discovery.code;
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
