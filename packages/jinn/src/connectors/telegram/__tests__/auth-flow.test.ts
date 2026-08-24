import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthFlowManager,
  parseAuthCommand,
  redactAuthOutput,
  type AuthPty,
  type SpawnPty,
} from "../auth-flow.js";

function createPty(): AuthPty {
  return {
    write: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
  };
}

function createManager(options: {
  ownerUserIds?: number[];
  getAuthStatus?: (provider: "claude" | "codex") => Promise<boolean>;
  spawnPty?: SpawnPty;
} = {}) {
  const sends: string[] = [];
  const deletes: Array<[number | string, number | string]> = [];
  const timers: Array<() => void> = [];
  const spawnPty =
    options.spawnPty ??
    (vi.fn((_file: string, _args: string[], _options: unknown) => createPty()) as SpawnPty);
  const manager = new AuthFlowManager({
    ownerUserIds: options.ownerUserIds ?? [67890],
    clock: {
      setTimeout: (handler) => {
        timers.push(handler);
        return handler;
      },
      clearTimeout: vi.fn(),
    },
    send: async (_chatId, text) => {
      sends.push(text);
    },
    deleteMessage: async (chatId, messageId) => {
      deletes.push([chatId, messageId]);
    },
    spawnPty,
    verifyAuth: vi.fn(async () => true),
    getAuthStatus: options.getAuthStatus,
    logger: {},
  });
  return { manager, sends, deletes, timers, spawnPty };
}

function authMessage(text: string, userId = 67890) {
  return {
    userId,
    chatType: "private",
    chatId: 12345,
    messageId: 42,
    text,
  };
}

describe("Telegram auth flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses only the supported owner auth commands", () => {
    expect(parseAuthCommand("/auth claude")).toEqual({ kind: "start", provider: "claude" });
    expect(parseAuthCommand("/auth codex")).toEqual({ kind: "start", provider: "codex" });
    expect(parseAuthCommand("/auth status")).toEqual({ kind: "status" });
    expect(parseAuthCommand("/auth cancel")).toEqual({ kind: "cancel" });
    expect(parseAuthCommand("/auth input AB12-CD34")).toEqual({ kind: "input", code: "AB12-CD34" });
    expect(parseAuthCommand("/auth token never-accepted")).toEqual({ kind: "rejected" });
    expect(parseAuthCommand("hello")).toBeNull();
  });

  it("redacts URLs, bearer-like values, and one-time codes from log text", () => {
    const safe = redactAuthOutput(
      "Open https://auth.example.test/callback?state=secret-state code AB12-CD34 Bearer eyJsecret",
    );
    expect(safe).not.toContain("auth.example.test");
    expect(safe).not.toContain("secret-state");
    expect(safe).not.toContain("AB12-CD34");
    expect(safe).not.toContain("eyJsecret");
  });

  it("offers login commands for unauthenticated provider status", async () => {
    const { manager, sends } = createManager({
      getAuthStatus: vi.fn(async () => false),
    });

    await manager.handleMessage(authMessage("/auth status"));

    expect(sends).toEqual([
      [
        "Claude is not authenticated. Use /auth claude to sign in.",
        "Codex is not authenticated. Use /auth codex to sign in.",
      ].join("\n"),
    ]);
  });

  it("reports authenticated provider states without login prompts", async () => {
    const { manager, sends } = createManager({
      getAuthStatus: vi.fn(async (provider) => provider === "claude"),
    });

    await manager.handleMessage(authMessage("/auth status"));

    expect(sends).toEqual([
      [
        "Claude is authenticated.",
        "Codex is not authenticated. Use /auth codex to sign in.",
      ].join("\n"),
    ]);
  });

  it("keeps active-flow status isolated by owner", async () => {
    const spawnPty = vi.fn(
      (_file: string, _args: string[], _options: unknown) => createPty(),
    ) as SpawnPty;
    const { manager, sends } = createManager({
      ownerUserIds: [67890, 11111],
      getAuthStatus: vi.fn(async () => false),
      spawnPty,
    });
    await manager.handleMessage(authMessage("/auth claude", 67890));

    await manager.handleMessage(authMessage("/auth status", 11111));

    expect(sends.at(-1)).toBe(
      [
        "Claude is not authenticated. Use /auth claude to sign in.",
        "Codex is not authenticated. Use /auth codex to sign in.",
      ].join("\n"),
    );
  });

  it("preserves active-flow status for the requesting owner", async () => {
    const spawnPty = vi.fn(
      (_file: string, _args: string[], _options: unknown) => createPty(),
    ) as SpawnPty;
    const { manager, sends } = createManager({
      getAuthStatus: vi.fn(async () => false),
      spawnPty,
    });
    await manager.handleMessage(authMessage("/auth claude"));

    await manager.handleMessage(authMessage("/auth status"));

    expect(sends.at(-1)).toBe(
      [
        "Active authentication flows: Claude.",
        "Claude is not authenticated. Use /auth claude to sign in.",
        "Codex is not authenticated. Use /auth codex to sign in.",
      ].join("\n"),
    );
  });
});
