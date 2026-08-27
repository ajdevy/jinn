import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthFlowManager,
  parseAuthCommand,
  redactAuthOutput,
  type AuthProvider,
  type AuthPty,
  type SpawnPty,
} from "../auth-flow.js";
import { extractDiscovery } from "../auth-flow-support.js";

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

function deferredBoolean() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
    expect(parseAuthCommand("/auth input AB12-CD34")).toEqual({ kind: "input", code: "AB12-CD34", source: "short-code" });
    expect(parseAuthCommand("/auth_claude")).toEqual({ kind: "start", provider: "claude" });
    expect(parseAuthCommand("/auth_input CODEabcdefghijklmnopqrstuvwxyz1234567890#state_1234567890123456")).toEqual({
      kind: "input",
      code: "CODEabcdefghijklmnopqrstuvwxyz1234567890#state_1234567890123456",
      source: "claude-callback",
    });
    expect(parseAuthCommand("/auth token never-accepted")).toEqual({ kind: "rejected" });
    expect(parseAuthCommand("hello")).toBeNull();
  });

  it("forwards Claude callback code and state intact", async () => {
    const pty = createPty();
    const spawnPty = vi.fn(() => pty) as SpawnPty;
    const { manager, deletes } = createManager({ spawnPty });
    const code = "CODEabcdefghijklmnopqrstuvwxyz1234567890";
    const state = "state_1234567890123456";

    await manager.handleMessage(authMessage("/auth_claude"));
    await manager.handleMessage(authMessage(`/auth_input ${code}#${state}`));

    expect(pty.write).toHaveBeenCalledWith(`${code}#${state}\r`);
    expect(deletes).toContainEqual([12345, 42]);

    await manager.handleMessage(
      authMessage(`/auth_input http://localhost:58741/callback?code=${code}&state=${state}`),
    );
    expect(pty.write).toHaveBeenLastCalledWith(`${code}#${state}\r`);
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

  it("extracts a standalone Codex device code", () => {
    expect(
      extractDiscovery(
        "Enter this one-time code (expires in 15 minutes)\nAB12CD345\nContinue only if you started this login in Codex.",
      ).code,
    ).toBe("AB12CD345");
  });

  it("extracts a Codex device code across terminal redraws", () => {
    expect(
      extractDiscovery(
        "Enter this one-time code (expires in 15 minutes)\rAB12CD345\rContinue only if you started this login in Codex.",
      ).code,
    ).toBe("AB12CD345");
  });

  it("sends the Codex device code found in terminal redraws", async () => {
    let onData: ((data: string) => void) | undefined;
    const pty: AuthPty = {
      write: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn((handler: (data: string) => void) => {
        onData = handler;
      }),
      onExit: vi.fn(),
    };
    const { manager, sends } = createManager({
      spawnPty: vi.fn(() => pty) as SpawnPty,
    });

    await manager.handleMessage(authMessage("/auth_codex"));
    onData?.(
      "https://auth.openai.com/codex/device\rEnter this one-time code (expires in 15 minutes)\rAB12CD345\rContinue only if you started this login in Codex.",
    );

    await vi.waitFor(() =>
      expect(sends).toContain(
        "Continue authentication:\nhttps://auth.openai.com/codex/device\nDevice code: AB12CD345",
      ),
    );
  });

  it("uses Codex-specific authentication instructions", async () => {
    const { manager, sends } = createManager();

    await manager.handleMessage(authMessage("/auth_codex"));

    expect(sends.at(-1)).toContain("Codex authentication started.");
    expect(sends.at(-1)).toContain("The bot will send the 9-character device code");
    expect(sends.at(-1)).toContain("enter it in the browser");
    expect(sends.at(-1)).not.toContain("/auth_input");
    expect(sends.at(-1)).not.toContain("If Claude");
  });

  it("offers login commands for unauthenticated provider status", async () => {
    const { manager, sends } = createManager({
      getAuthStatus: vi.fn(async () => false),
    });

    await manager.handleMessage(authMessage("/auth status"));

    expect(sends).toEqual([
      [
        "Claude is not authenticated. Use /auth_claude to sign in.",
        "Codex is not authenticated. Use /auth_codex to sign in.",
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
        "Codex is not authenticated. Use /auth_codex to sign in.",
      ].join("\n"),
    ]);
  });

  it("checks provider status concurrently", async () => {
    const calls: AuthProvider[] = [];
    const claude = deferredBoolean();
    const codex = deferredBoolean();
    const { manager, sends } = createManager({
      getAuthStatus: vi.fn(async (provider) => {
        calls.push(provider);
        return provider === "claude" ? claude.promise : codex.promise;
      }),
    });

    const status = manager.handleMessage(authMessage("/auth status"));
    await vi.waitFor(() => expect(calls).toEqual(["claude", "codex"]));
    claude.resolve(true);
    codex.resolve(false);
    await status;
    expect(sends).toEqual([
      [
        "Claude is authenticated.",
        "Codex is not authenticated. Use /auth_codex to sign in.",
      ].join("\n"),
    ]);
  });

  it("bounds provider status checks to the status timeout window", async () => {
    const { manager, sends, timers } = createManager({
      getAuthStatus: vi.fn(async () => new Promise<boolean>(() => undefined)),
    });

    const status = manager.handleMessage(authMessage("/auth status"));
    await vi.waitFor(() => expect(timers).toHaveLength(2));
    timers.splice(0).forEach((timer) => timer());
    await status;

    expect(sends).toEqual([
      [
        "Claude is not authenticated. Use /auth_claude to sign in.",
        "Codex is not authenticated. Use /auth_codex to sign in.",
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
        "Claude is not authenticated. Use /auth_claude to sign in.",
        "Codex is not authenticated. Use /auth_codex to sign in.",
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
        "Claude is not authenticated. Use /auth_claude to sign in.",
        "Codex is not authenticated. Use /auth_codex to sign in.",
      ].join("\n"),
    );
  });
});
