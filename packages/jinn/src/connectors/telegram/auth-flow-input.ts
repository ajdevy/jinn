import type { AuthCommand } from "./auth-flow-types.js";

const CODE_PATTERN = /^[A-Z0-9](?:[A-Z0-9-]{2,30}[A-Z0-9])$/;
const CLAUDE_CALLBACK_CODE_PATTERN = /^[A-Za-z0-9]{40,128}$/;
const CALLBACK_STATE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const CLAUDE_CALLBACK_INPUT_PATTERN = /^[A-Za-z0-9]{40,128}#[A-Za-z0-9_-]{16,256}$/;

export function isAuthCode(value: string): boolean {
  return CODE_PATTERN.test(value);
}

export function parseAuthInput(value: string): AuthCommand | null {
  if (isAuthCode(value)) return { kind: "input", code: value, source: "short-code" };
  const callbackCode = parseClaudeCallbackCode(value);
  return callbackCode
    ? { kind: "input", code: callbackCode, source: "claude-callback" }
    : null;
}

function parseClaudeCallbackCode(value: string): string | null {
  if (CLAUDE_CALLBACK_INPUT_PATTERN.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "::1"].includes(host) ||
    url.pathname !== "/callback"
  ) {
    return null;
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  return code &&
    state &&
    CLAUDE_CALLBACK_CODE_PATTERN.test(code) &&
    CALLBACK_STATE_PATTERN.test(state)
    ? `${code}#${state}`
    : null;
}
