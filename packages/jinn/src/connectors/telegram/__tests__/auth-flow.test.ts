import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthFlowManager,
  parseAuthCommand,
  redactAuthOutput,
  type AuthClock,
  type AuthMessage,
  type AuthProvider,
  type AuthSpawnOptions,
} from "../auth-flow.js";

function makePty() {
  let dataHandler: ((data: string) => void) | undefined;
  let exitHandler: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  const write = vi.fn<(data: string) => void>();
  const kill = vi.fn<(signal?: string) => void>();

  return {
    write,
    kill,
    onData: (handler: (data: string) => void) => {
      dataHandler = handler;
      return { dispose: vi.fn() };
    },
    onExit: (handler: (event: { exitCode: number; signal?: number }) => void) => {
      exitHandler = handler;
      return { dispose: vi.fn() };
    },
    emitData: (data: string) => dataHandler?.(data),
    emitExit: (event: { exitCode: number; signal?: number }) => exitHandler?.(event),
  };
}

function makeHarness(
  options: {
    withVerifier?: boolean;
    ownerUserIds?: readonly number[];
    verifyTimeoutSeconds?: number;
    deleteSensitiveInputFromNonOwners?: boolean;
  } = {},
) {
  const pty = makePty();
  const ptys = [pty];
  let spawnCount = 0;
  let nowMs = 0;
  let timeoutHandler: (() => void) | undefined;
  const clearTimeout = vi.fn();
  const clock: AuthClock = {
    now: () => nowMs,
    setTimeout: vi.fn((handler: () => void, _delayMs: number) => {
      timeoutHandler = handler;
      return 1;
    }),
    clearTimeout,
  };
  const send = vi.fn();
  const deleteMessage = vi.fn().mockResolvedValue(undefined);
  const spawnPty = vi.fn(
    (_file: string, _args: string[], _options: AuthSpawnOptions) => {
      if (spawnCount === 0) {
        spawnCount += 1;
        return pty;
      }
      const nextPty = makePty();
      ptys.push(nextPty);
      spawnCount += 1;
      return nextPty;
    },
  );
  const verifyAuth = vi
    .fn<(provider: AuthProvider) => Promise<boolean>>()
    .mockResolvedValue(true);
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const manager = new AuthFlowManager({
    ownerUserIds: options.ownerUserIds ?? [5658965359],
    clock,
    send,
    deleteMessage,
    spawnPty,
    ...(options.withVerifier === false ? {} : { verifyAuth }),
    deleteSensitiveInputFromNonOwners:
      options.deleteSensitiveInputFromNonOwners ?? true,
    verifyTimeoutSeconds: options.verifyTimeoutSeconds,
    logger,
  });

  return {
    manager,
    pty,
    ptys,
    clock,
    send,
    deleteMessage,
    spawnPty,
    verifyAuth,
    logger,
    fireTimeout: () => timeoutHandler?.(),
    advanceTime: (delayMs: number) => {
      nowMs += delayMs;
    },
  };
}

function message(text: string, overrides: Partial<AuthMessage> = {}): AuthMessage {
  return {
    userId: 5658965359,
    chatType: "private",
    chatId: 123,
    messageId: 7,
    text,
    ...overrides,
  };
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("parseAuthCommand", () => {
  it("parses only supported auth commands and rejects token variants", () => {
    expect(parseAuthCommand("/auth_claude")).toEqual({ kind: "start", provider: "claude" });
    expect(parseAuthCommand("/auth_codex@jinn_bot")).toEqual({
      kind: "start",
      provider: "codex",
    });
    expect(parseAuthCommand("/auth_status")).toEqual({ kind: "status" });
    expect(parseAuthCommand("/auth_cancel")).toEqual({ kind: "cancel" });
    expect(parseAuthCommand("/auth claude")).toEqual({ kind: "start", provider: "claude" });
    expect(parseAuthCommand("/auth@jinn codex")).toEqual({ kind: "start", provider: "codex" });
    expect(parseAuthCommand("/auth status")).toEqual({ kind: "status" });
    expect(parseAuthCommand("/auth cancel")).toEqual({ kind: "cancel" });
    expect(parseAuthCommand("/auth input AB12-CD34")).toEqual({
      kind: "input",
      code: "AB12-CD34",
    });
    expect(parseAuthCommand("/auth_input AB12-CD34")).toEqual({
      kind: "input",
      code: "AB12-CD34",
    });
    expect(parseAuthCommand("/auth_input=AB12-CD34")).toEqual({
      kind: "input",
      code: "AB12-CD34",
    });
    expect(parseAuthCommand("/auth_input")).toEqual({ kind: "rejected" });
    expect(parseAuthCommand("/auth_input:AB12-CD34")).toEqual({
      kind: "input",
      code: "AB12-CD34",
    });
    expect(parseAuthCommand("/auth_input bad-code")).toEqual({ kind: "rejected" });
    expect(parseAuthCommand("/auth token never-accepted")).toEqual({ kind: "rejected" });
    expect(parseAuthCommand("/auth_token: never-accepted")).toEqual({ kind: "rejected" });
    expect(parseAuthCommand("/auth access-token never-accepted")).toEqual({ kind: "rejected" });
    expect(parseAuthCommand("/auth input ab12-cd34")).toEqual({ kind: "rejected" });
    expect(parseAuthCommand("hello")).toBeNull();
  });
});

describe("redactAuthOutput", () => {
  it("redacts URLs, bearer values, JWTs, and one-time codes", () => {
    const safe = redactAuthOutput(
      "Open https://auth.example.test/callback?state=secret-state code AB12-CD34 Bearer eyJsecret abc.def.ghi",
    );

    expect(safe).not.toContain("auth.example.test");
    expect(safe).not.toContain("secret-state");
    expect(safe).not.toContain("AB12-CD34");
    expect(safe).not.toContain("eyJsecret");
    expect(safe).not.toContain("abc.def.ghi");
  });
});

describe("AuthFlowManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("consumes auth commands from a non-owner without spawning or disclosing auth", async () => {
    const harness = makeHarness();

    await expect(
      harness.manager.handleMessage(message("/auth claude", { userId: 999999 })),
    ).resolves.toBe(true);

    expect(harness.spawnPty).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("deletes sensitive auth text from an allow-listed non-owner", async () => {
    const harness = makeHarness();

    await expect(
      harness.manager.handleMessage(
        message("/auth_token=secret-value", { userId: 999999 }),
      ),
    ).resolves.toBe(true);

    expect(harness.deleteMessage).toHaveBeenCalledWith(123, 7);
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.spawnPty).not.toHaveBeenCalled();
  });

  it("deletes sensitive auth text from an allow-listed non-owner in a group", async () => {
    const harness = makeHarness();

    await expect(
      harness.manager.handleMessage(
        message("/auth_token=secret-value", {
          userId: 999999,
          chatType: "group",
        }),
      ),
    ).resolves.toBe(true);

    expect(harness.deleteMessage).toHaveBeenCalledWith(123, 7);
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.spawnPty).not.toHaveBeenCalled();
  });

  it("scrubs non-owner payloads even when no owner IDs are configured", async () => {
    const harness = makeHarness({ ownerUserIds: [] });

    await expect(
      harness.manager.handleMessage(
        message("/auth_token=secret-value", { userId: 999999 }),
      ),
    ).resolves.toBe(true);

    expect(harness.deleteMessage).toHaveBeenCalledWith(123, 7);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("does not delete a non-owner payload when non-owner scrubbing is disabled", async () => {
    const harness = makeHarness({ deleteSensitiveInputFromNonOwners: false });

    await expect(
      harness.manager.handleMessage(
        message("/auth_token=secret-value", { userId: 999999 }),
      ),
    ).resolves.toBe(true);

    expect(harness.deleteMessage).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("leaves unrelated auth-prefixed text for the normal message handler", async () => {
    const harness = makeHarness();

    await expect(
      harness.manager.handleMessage(message("/auth_notes: buy milk")),
    ).resolves.toBe(false);

    expect(harness.deleteMessage).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.spawnPty).not.toHaveBeenCalled();
  });

  it("warns when a sensitive auth message cannot be deleted", async () => {
    const harness = makeHarness();
    harness.deleteMessage.mockRejectedValueOnce(new Error("telegram failure"));

    await harness.manager.handleMessage(message("/auth_token=secret-value"));

    expect(harness.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining("could not be deleted"),
    );

    harness.send.mockClear();
    await harness.manager.handleMessage(message("/auth claude"));
    harness.deleteMessage.mockRejectedValueOnce(new Error("telegram failure"));
    await harness.manager.handleMessage(message("/auth input AB12-CD34"));
    expect(harness.send).toHaveBeenCalledWith(
      123,
      "Warning: the message could not be deleted. Remove it manually.",
    );
    expect(harness.pty.write).toHaveBeenCalledWith("AB12-CD34\r");
  });

  it("keeps a non-owner silent when a group secret cannot be deleted", async () => {
    const harness = makeHarness();
    harness.deleteMessage.mockRejectedValueOnce(new Error("telegram failure"));

    await harness.manager.handleMessage(
      message("/auth_token=secret-value", {
        userId: 999999,
        chatType: "group",
      }),
    );

    expect(harness.send).not.toHaveBeenCalled();
  });

  it("rejects auth commands from non-private chats before spawning", async () => {
    const harness = makeHarness();

    await expect(
      harness.manager.handleMessage(message("/auth claude", { chatType: "group" })),
    ).resolves.toBe(true);

    expect(harness.spawnPty).not.toHaveBeenCalled();
    expect(harness.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining("private"),
    );
  });

  it("routes menu command forms through the auth handler", async () => {
    const harness = makeHarness();

    await harness.manager.handleMessage(message("/auth_claude"));
    expect(harness.spawnPty).toHaveBeenCalledWith(
      "claude",
      ["auth", "login", "--claudeai"],
      expect.anything(),
    );

    harness.send.mockClear();
    await harness.manager.handleMessage(message("/auth_status"));
    expect(harness.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining("Claude"),
    );

    await harness.manager.handleMessage(message("/auth_cancel"));
    expect(harness.pty.kill).toHaveBeenCalledOnce();
  });

  it("does not delete bare authentication commands", async () => {
    const harness = makeHarness();

    await harness.manager.handleMessage(message("/auth claude"));
    await harness.manager.handleMessage(message("/auth_status"));
    await harness.manager.handleMessage(message("/auth cancel"));

    expect(harness.deleteMessage).not.toHaveBeenCalled();
  });

  it("consumes equals-separated auth commands before the normal agent handler", async () => {
    const harness = makeHarness();

    await expect(
      harness.manager.handleMessage(message("/auth_token=secret-value")),
    ).resolves.toBe(true);
    await expect(
      harness.manager.handleMessage(message("/auth_api_key=secret-value")),
    ).resolves.toBe(true);
    await expect(
      harness.manager.handleMessage(message("/auth_access-token=secret-value")),
    ).resolves.toBe(true);
    await expect(
      harness.manager.handleMessage(message("/auth_token: secret-value")),
    ).resolves.toBe(true);
    await expect(
      harness.manager.handleMessage(message("/auth_input=AB12-CD34")),
    ).resolves.toBe(true);
    await expect(
      harness.manager.handleMessage(message("/auth token secret-value\nsecond line")),
    ).resolves.toBe(true);
    await expect(
      harness.manager.handleMessage(
        message("/auth_token=secret-value", { chatType: "group" }),
      ),
    ).resolves.toBe(true);

    expect(harness.deleteMessage).toHaveBeenCalledTimes(7);
    expect(harness.spawnPty).not.toHaveBeenCalled();
    expect(harness.send.mock.calls.flat().join(" ")).not.toContain("secret-value");
  });

  it("reports exact provider status lines and reuses the short-lived cache", async () => {
    const harness = makeHarness();
    harness.verifyAuth.mockImplementation(async (provider) => provider === "claude");

    await harness.manager.handleMessage(message("/auth_status"));
    expect(harness.send).toHaveBeenNthCalledWith(
      1,
      123,
      "No authentication flow is active.\nChecking authentication status...",
    );
    expect(harness.send).toHaveBeenNthCalledWith(
      2,
      123,
      "No authentication flow is active.\nClaude: authenticated.\nCodex: not authenticated.",
    );

    harness.send.mockClear();
    await harness.manager.handleMessage(message("/auth_status"));
    expect(harness.send).toHaveBeenNthCalledWith(
      1,
      123,
      "No authentication flow is active.\nClaude: authenticated.\nCodex: not authenticated.",
    );
    expect(harness.verifyAuth).toHaveBeenCalledTimes(2);

    harness.advanceTime(5_001);
    harness.send.mockClear();
    await harness.manager.handleMessage(message("/auth_status"));
    expect(harness.verifyAuth).toHaveBeenCalledTimes(4);
    expect(harness.send).toHaveBeenNthCalledWith(
      2,
      123,
      "No authentication flow is active.\nClaude: authenticated.\nCodex: not authenticated.",
    );
  });

  it("reports provider verification timeouts in status", async () => {
    const harness = makeHarness();
    harness.verifyAuth.mockRejectedValue(
      Object.assign(new Error("timed out"), { timedOut: true }),
    );

    await harness.manager.handleMessage(message("/auth_status"));

    expect(harness.send).toHaveBeenNthCalledWith(
      2,
      123,
      "No authentication flow is active.\nClaude: verification timed out.\nCodex: verification timed out.",
    );
  });

  it("refreshes cached provider status after an authentication flow completes", async () => {
    const harness = makeHarness();
    harness.verifyAuth.mockResolvedValue(false);
    await harness.manager.handleMessage(message("/auth_status"));

    harness.verifyAuth.mockImplementation(async (provider) => provider === "claude");
    await harness.manager.handleMessage(message("/auth claude"));
    harness.send.mockClear();
    harness.pty.emitExit({ exitCode: 0 });
    await flushAsync();

    expect(harness.send).toHaveBeenCalledWith(
      123,
      "Claude authentication succeeded: authenticated.\nNext: authenticate Codex with /auth_codex.",
    );

    harness.send.mockClear();
    await harness.manager.handleMessage(message("/auth_status"));
    expect(harness.send).toHaveBeenLastCalledWith(
      123,
      "No authentication flow is active.\nClaude: authenticated.\nCodex: not authenticated.",
    );
  });

  it("consumes underscore sensitive-input variants without writing them to a session", async () => {
    const harness = makeHarness();

    await expect(
      harness.manager.handleMessage(message("/auth_input AB12-CD34")),
    ).resolves.toBe(true);
    await expect(
      harness.manager.handleMessage(message("/auth_token secret-value")),
    ).resolves.toBe(true);

    expect(harness.deleteMessage).toHaveBeenCalledTimes(2);
    expect(harness.send).toHaveBeenCalledWith(
      123,
      "No authentication flow is active.",
    );
    expect(harness.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining("tokens are not accepted"),
    );
    expect(harness.spawnPty).not.toHaveBeenCalled();
  });

  it("spawns the exact provider command with fixed non-secret environment paths", async () => {
    const harness = makeHarness();

    await harness.manager.handleMessage(message("/auth claude"));
    expect(harness.spawnPty).toHaveBeenCalledWith(
      "claude",
      ["auth", "login", "--claudeai"],
      expect.objectContaining({
        env: expect.objectContaining({
          HOME: "/home/node",
          CLAUDE_CONFIG_DIR: "/home/node/.claude",
          CODEX_HOME: "/home/node/.codex",
        }),
      }),
    );

    harness.spawnPty.mockClear();
    await harness.manager.handleMessage(message("/auth cancel"));
    await harness.manager.handleMessage(message("/auth codex"));
    expect(harness.spawnPty).toHaveBeenCalledWith(
      "codex",
      ["login", "--device-auth"],
      expect.anything(),
    );
    const argv = harness.spawnPty.mock.calls.flatMap((call) => call[1]);
    expect(argv.some((arg) => /token|secret|oauth/i.test(arg))).toBe(false);
  });

  it("keeps provider flows independent and reports all active providers", async () => {
    const harness = makeHarness();

    await harness.manager.handleMessage(message("/auth claude"));
    await harness.manager.handleMessage(message("/auth codex"));

    expect(harness.spawnPty).toHaveBeenCalledTimes(2);
    expect(harness.ptys[0].kill).not.toHaveBeenCalled();
    expect(harness.ptys[1].kill).not.toHaveBeenCalled();
    await harness.manager.handleMessage(message("/auth status"));
    expect(harness.send).toHaveBeenLastCalledWith(
      123,
      expect.stringContaining("Claude"),
    );
    expect(harness.send.mock.calls.at(-1)?.[1]).toContain("Codex");
  });

  it("replaces only the same provider and ignores stale callbacks", async () => {
    const harness = makeHarness();

    await harness.manager.handleMessage(message("/auth claude"));
    await harness.manager.handleMessage(message("/auth codex"));
    await harness.manager.handleMessage(message("/auth claude"));

    expect(harness.ptys[0].kill).toHaveBeenCalledOnce();
    expect(harness.ptys[1].kill).not.toHaveBeenCalled();

    harness.send.mockClear();
    harness.ptys[0].emitData("Open https://stale.example.test/login");
    harness.ptys[0].emitExit({ exitCode: 0 });
    await Promise.resolve();
    expect(harness.send).not.toHaveBeenCalled();

    await harness.manager.handleMessage(message("/auth cancel"));
    expect(harness.ptys[1].kill).toHaveBeenCalledOnce();
    expect(harness.ptys[2].kill).toHaveBeenCalledOnce();
    harness.ptys[1].emitExit({ exitCode: 0 });
    harness.ptys[2].emitExit({ exitCode: 0 });
    await Promise.resolve();
    expect(harness.send).toHaveBeenLastCalledWith(
      123,
      expect.stringContaining("cancel"),
    );
  });

  it("fails closed when input is ambiguous across active providers", async () => {
    const harness = makeHarness();

    await harness.manager.handleMessage(message("/auth claude"));
    await harness.manager.handleMessage(message("/auth codex"));
    harness.send.mockClear();

    await harness.manager.handleMessage(message("/auth input AB12-CD34"));

    expect(harness.ptys[0].write).not.toHaveBeenCalled();
    expect(harness.ptys[1].write).not.toHaveBeenCalled();
    expect(harness.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining("ambiguous"),
    );
  });

  it("isolates active flows by canonical owner ID and provider", async () => {
    const secondOwner = 4242424242;
    const harness = makeHarness({
      ownerUserIds: [5658965359, secondOwner],
    });

    await harness.manager.handleMessage(message("/auth claude"));
    await harness.manager.handleMessage(
      message("/auth claude", {
        userId: String(secondOwner),
        chatId: 456,
        messageId: 8,
      }),
    );

    expect(harness.spawnPty).toHaveBeenCalledTimes(2);
    expect(harness.ptys[0].kill).not.toHaveBeenCalled();
    expect(harness.ptys[1].kill).not.toHaveBeenCalled();

    harness.send.mockClear();
    await harness.manager.handleMessage(
      message("/auth status", {
        userId: String(secondOwner),
        chatId: 456,
      }),
    );
    expect(harness.send).toHaveBeenLastCalledWith(
      456,
      expect.stringContaining("Claude"),
    );
    await harness.manager.handleMessage(message("/auth status"));
    expect(harness.send).toHaveBeenLastCalledWith(
      123,
      expect.stringContaining("Claude"),
    );

    await harness.manager.handleMessage(message("/auth input AB12-CD34"));
    expect(harness.ptys[0].write).toHaveBeenCalledWith("AB12-CD34\r");
    expect(harness.ptys[1].write).not.toHaveBeenCalled();

    await harness.manager.handleMessage(
      message("/auth input ZX12-AB34", {
        userId: String(secondOwner),
        chatId: 456,
        messageId: 10,
      }),
    );
    expect(harness.ptys[1].write).toHaveBeenCalledWith("ZX12-AB34\r");

    await harness.manager.handleMessage(
      message("/auth cancel", {
        userId: 5658965359,
        chatId: 123,
      }),
    );
    expect(harness.ptys[0].kill).toHaveBeenCalledOnce();
    expect(harness.ptys[1].kill).not.toHaveBeenCalled();

    await harness.manager.handleMessage(
      message("/auth cancel", {
        userId: String(secondOwner),
        chatId: 456,
        messageId: 9,
      }),
    );
    expect(harness.ptys[1].kill).toHaveBeenCalledOnce();
  });

  it("deletes the input message and writes only a validated short code to the PTY", async () => {
    const harness = makeHarness();

    await harness.manager.handleMessage(message("/auth claude"));
    await harness.manager.handleMessage(message("/auth input AB12-CD34"));

    expect(harness.deleteMessage).toHaveBeenCalledWith(123, 7);
    expect(harness.pty.write).toHaveBeenCalledWith("AB12-CD34\r");
    expect(harness.pty.write).toHaveBeenCalledOnce();

    harness.deleteMessage.mockRejectedValueOnce(new Error("telegram failure"));
    await expect(
      harness.manager.handleMessage(message("/auth input bad-code")),
    ).resolves.toBe(true);
    expect(harness.pty.write).toHaveBeenCalledOnce();
  });

  it("sends an extracted URL and device code once without logging PTY output", async () => {
    const harness = makeHarness();

    await harness.manager.handleMessage(message("/auth codex"));
    harness.send.mockClear();
    harness.pty.emitData("Open https://auth.openai.com/device?state=secret-state");
    await Promise.resolve();
    harness.pty.emitData("\\nDevice code: AB12-CD34");
    await Promise.resolve();
    harness.pty.emitData(
      "\\nOpen https://auth.openai.com/device?state=secret-state Device code: AB12-CD34",
    );
    await Promise.resolve();

    expect(harness.send).toHaveBeenCalledTimes(2);
    expect(harness.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining("https://auth.openai.com/device?state=secret-state"),
    );
    expect(harness.send.mock.calls[1][1]).toContain("AB12-CD34");
    for (const mock of [
      harness.logger.debug,
      harness.logger.info,
      harness.logger.warn,
      harness.logger.error,
    ]) {
      expect(mock.mock.calls.flat().join(" ")).not.toContain("secret-state");
      expect(mock.mock.calls.flat().join(" ")).not.toContain("AB12-CD34");
    }
  });

  it("extracts discovery from an oversized PTY chunk before retaining only the output tail", async () => {
    const harness = makeHarness();
    const url = "https://auth.openai.com/device?state=oversized-state";
    const code = "OVSZ-1234";

    await harness.manager.handleMessage(message("/auth codex"));
    harness.send.mockClear();
    harness.pty.emitData(
      "Open " + url + " Device code: " + code + " " + "x".repeat(70 * 1024),
    );
    await Promise.resolve();

    expect(harness.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining(url),
    );
    expect(harness.send.mock.calls.flat().join(" ")).toContain(code);
  });

  it("flushes buffered discovery before processing a same-turn PTY exit", async () => {
    const harness = makeHarness();

    await harness.manager.handleMessage(message("/auth codex"));
    harness.send.mockClear();
    harness.pty.emitData(
      "Open https://auth.openai.com/device?state=final-state Device code: ZX12-AB34",
    );
    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.send.mock.calls[0][1]).toContain(
      "https://auth.openai.com/device?state=final-state",
    );
    expect(harness.send.mock.calls[0][1]).toContain("ZX12-AB34");
    harness.pty.emitExit({ exitCode: 1 });
    await flushAsync();

    expect(harness.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining("https://auth.openai.com/device?state=final-state"),
    );
    expect(harness.send.mock.calls.flat().join(" ")).toContain("ZX12-AB34");
  });

  it("reports generic success and failure based only on exit status", async () => {
    const harness = makeHarness();

    await harness.manager.handleMessage(message("/auth claude"));
    harness.send.mockClear();
    harness.pty.emitExit({ exitCode: 0 });
    await flushAsync();
    expect(harness.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining("authenticated"),
    );

    await harness.manager.handleMessage(message("/auth codex"));
    harness.send.mockClear();
    harness.ptys[1].emitExit({ exitCode: 1 });
    await Promise.resolve();
    expect(harness.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining("failed"),
    );
    expect(harness.send.mock.calls.flat().join(" ")).not.toMatch(/stdout|stderr|token|AB12-CD34/i);
  });

  it("offers Codex after Claude authentication succeeds", async () => {
    const harness = makeHarness();
    harness.verifyAuth.mockImplementation(async (provider) => provider === "claude");

    await harness.manager.handleMessage(message("/auth claude"));
    harness.send.mockClear();
    harness.pty.emitExit({ exitCode: 0 });
    await flushAsync();

    expect(harness.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining("/auth_codex"),
    );
  });

  it("does not offer Codex when it is already authenticated", async () => {
    const harness = makeHarness();

    await harness.manager.handleMessage(message("/auth claude"));
    harness.send.mockClear();
    harness.pty.emitExit({ exitCode: 0 });
    await flushAsync();

    expect(harness.send).toHaveBeenCalledWith(
      123,
      "Claude authentication succeeded: authenticated.",
    );
  });

  it("does not offer Codex when a Codex flow is already running", async () => {
    const harness = makeHarness();
    harness.verifyAuth.mockImplementation(async (provider) => provider === "claude");

    await harness.manager.handleMessage(message("/auth claude"));
    await harness.manager.handleMessage(message("/auth codex"));
    harness.send.mockClear();
    harness.ptys[0].emitExit({ exitCode: 0 });
    await flushAsync();

    expect(harness.send).toHaveBeenCalledWith(
      123,
      "Claude authentication succeeded: authenticated.",
    );
    expect(harness.ptys[1].kill).not.toHaveBeenCalled();
  });

  it("requires post-exit verification before reporting authentication success", async () => {
    const harness = makeHarness();

    harness.verifyAuth.mockResolvedValueOnce(false);
    await harness.manager.handleMessage(message("/auth claude"));
    harness.send.mockClear();
    harness.pty.emitExit({ exitCode: 0 });
    await flushAsync();

    expect(harness.verifyAuth).toHaveBeenCalledWith("claude");
    expect(harness.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining("failed"),
    );
    expect(harness.send.mock.calls.flat().join(" ")).not.toMatch(/authenticated/i);
  });

  it("fails closed when the post-exit verifier is missing", async () => {
    const harness = makeHarness({ withVerifier: false });

    await harness.manager.handleMessage(message("/auth codex"));
    harness.send.mockClear();
    harness.pty.emitExit({ exitCode: 0 });
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining("failed"),
    );
    expect(harness.send.mock.calls.flat().join(" ")).not.toMatch(/authenticated/i);
  });

  it("fails closed when post-exit verification exceeds the injected timeout", async () => {
    const harness = makeHarness({ verifyTimeoutSeconds: 1 });
    harness.verifyAuth.mockReturnValueOnce(new Promise<boolean>(() => {}));

    await harness.manager.handleMessage(message("/auth claude"));
    harness.send.mockClear();
    harness.pty.emitExit({ exitCode: 0 });
    await Promise.resolve();

    harness.fireTimeout();
    await flushAsync();

    expect(harness.verifyAuth).toHaveBeenCalledWith("claude");
    expect(harness.send).toHaveBeenCalledWith(
      123,
      "Claude authentication verification timed out. Try again with /auth_claude.",
    );
    expect(harness.send.mock.calls.flat().join(" ")).toContain("/auth_claude");
    expect(harness.send.mock.calls.flat().join(" ")).not.toMatch(/authenticated/i);

    harness.send.mockClear();
    await harness.manager.handleMessage(message("/auth status"));
    expect(harness.send).toHaveBeenCalledWith(
      123,
      "No authentication flow is active.\nClaude: verification timed out.\nCodex: authenticated.",
    );
  });

  it("kills and clears the flow on timeout, cancel, and stop", async () => {
    const harness = makeHarness();

    await harness.manager.handleMessage(message("/auth claude"));
    harness.fireTimeout();
    expect(harness.ptys[0].kill).toHaveBeenCalledOnce();
    expect(harness.clock.clearTimeout).toHaveBeenCalled();
    expect(harness.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining("/auth_claude"),
    );

    await harness.manager.handleMessage(message("/auth codex"));
    await harness.manager.handleMessage(message("/auth cancel"));
    expect(harness.ptys[1].kill).toHaveBeenCalledOnce();
    expect(harness.send).toHaveBeenLastCalledWith(
      123,
      expect.stringContaining("cancel"),
    );

    await harness.manager.handleMessage(message("/auth claude"));
    harness.manager.stop();
    expect(harness.ptys[2].kill).toHaveBeenCalledOnce();
  });
});
