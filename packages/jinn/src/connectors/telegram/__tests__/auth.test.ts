import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_MENU_COMMANDS,
  TelegramAuth,
  isAuthCommandPrefix,
  parseAuthCommand,
  type AuthClock,
  type AuthMessage,
  type AuthPty,
  type AuthSpawnOptions,
} from "../auth.js";
import type { RunCommand } from "../auth-providers.js";

function makePty(): AuthPty & { emitData(data: string): void; emitExit(exitCode: number): void } {
  let dataHandler: ((data: string) => void) | undefined;
  let exitHandler: ((event: { exitCode: number }) => void) | undefined;
  return {
    write: vi.fn(),
    kill: vi.fn(),
    onData: (handler) => { dataHandler = handler; return { dispose: vi.fn() }; },
    onExit: (handler) => { exitHandler = handler; return { dispose: vi.fn() }; },
    emitData: (data) => dataHandler?.(data),
    emitExit: (exitCode) => exitHandler?.({ exitCode }),
  };
}

function makeHarness(options: { ownerUserIds?: readonly number[] } = {}) {
  let now = 0;
  const timers = new Map<unknown, () => void>();
  const pty = makePty();
  const send = vi.fn();
  const deleteMessage = vi.fn().mockResolvedValue(undefined);
  const setMyCommands = vi.fn().mockResolvedValue(true);
  const spawnPty = vi.fn((_file: string, _args: readonly string[], _options: AuthSpawnOptions) => pty);
  const run = vi.fn<RunCommand>().mockResolvedValue({ stdout: JSON.stringify({ loggedIn: true }), exitCode: 0 });
  const clock: AuthClock = {
    now: () => now,
    setTimeout: (handler) => {
      const handle = Symbol("timer");
      timers.set(handle, handler);
      return handle;
    },
    clearTimeout: (handle) => { timers.delete(handle); },
  };
  const auth = new TelegramAuth({
    bot: { setMyCommands },
    ownerUserIds: options.ownerUserIds ?? [67890],
    allowFrom: new Set([67890]),
    env: process.env,
    send,
    deleteMessage,
    spawnPty,
    runCommand: run,
    clock,
    logger: { warn: vi.fn(), error: vi.fn() },
  });
  return {
    auth,
    pty,
    send,
    deleteMessage,
    setMyCommands,
    spawnPty,
    run,
    fireTimers: () => { for (const handler of timers.values()) handler(); },
    advanceTime: (amount: number) => { now += amount; },
  };
}

function message(text: string, overrides: Partial<AuthMessage> = {}): AuthMessage {
  return { userId: 67890, chatType: "private", chatId: 123, messageId: 7, text, ...overrides };
}

describe("TelegramAuth", () => {
  beforeEach(() => vi.clearAllMocks());

  it("recognizes supported commands and rejects provider tokens", () => {
    expect(parseAuthCommand("/auth claude")).toEqual({ kind: "start", provider: "claude" });
    expect(parseAuthCommand("/auth_codex@jinn_bot")).toEqual({ kind: "start", provider: "codex" });
    expect(parseAuthCommand("/auth status")).toEqual({ kind: "status" });
    expect(parseAuthCommand("/auth_input AB12-CD34")).toEqual({ kind: "input", code: "AB12-CD34", source: "short-code" });
    expect(parseAuthCommand("/auth input ab12-cd34")).toEqual({ kind: "rejected" });
    const claudeCode = "Ab".repeat(24);
    expect(parseAuthCommand(`/auth_input http://localhost:58741/callback?code=${claudeCode}&state=state_1234567890123456`)).toEqual({
      kind: "input",
      code: claudeCode,
      source: "claude-callback",
    });
    expect(parseAuthCommand(`/auth_input ${claudeCode}`)).toEqual({ kind: "rejected" });
    expect(parseAuthCommand(`/auth_input https://example.com/callback?code=${claudeCode}&state=state_1234567890123456`)).toEqual({ kind: "rejected" });
    expect(parseAuthCommand("/auth_token=secret")).toEqual({ kind: "rejected" });
    expect(parseAuthCommand("hello")).toBeNull();
    expect(isAuthCommandPrefix("/auth_notes: secret")).toBe(true);
    expect(isAuthCommandPrefix("/authentication status")).toBe(false);
  });

  it("uses the provider table for both login status commands", async () => {
    const harness = makeHarness();
    await harness.auth.handle(message("/auth status"));

    expect(harness.run).toHaveBeenCalledWith("claude", ["auth", "status", "--json"], expect.any(Number));
    expect(harness.run).toHaveBeenCalledWith("codex", ["login", "status"], expect.any(Number));
    expect(harness.send).toHaveBeenLastCalledWith(
      123,
      "No authentication flow is active.\nClaude: authenticated.\nCodex: authenticated.",
    );
  });

  it("publishes one owner-scoped menu and spawns with the inherited runtime", async () => {
    const harness = makeHarness();
    harness.auth.start();
    await Promise.resolve();

    expect(harness.setMyCommands).toHaveBeenCalledOnce();
    expect(harness.setMyCommands).toHaveBeenCalledWith(AUTH_MENU_COMMANDS, { scope: { type: "chat", chat_id: 67890 } });

    await harness.auth.handle(message("/auth_claude"));
    expect(harness.spawnPty).toHaveBeenCalledWith(
      "claude",
      ["auth", "login", "--claudeai"],
      expect.objectContaining({ cwd: process.cwd(), env: process.env }),
    );
    expect(harness.setMyCommands).toHaveBeenCalledOnce();
  });

  it("scrubs non-owner payloads before the owner check and stays silent", async () => {
    const harness = makeHarness();
    await expect(harness.auth.handle(message("/auth_token=secret", { userId: 99999 }))).resolves.toBe(true);

    expect(harness.deleteMessage).toHaveBeenCalledWith(123, 7);
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.spawnPty).not.toHaveBeenCalled();
  });

  it("warns the owner when a command message cannot be deleted", async () => {
    const harness = makeHarness();
    harness.deleteMessage.mockRejectedValue(new Error("delete failed"));

    await harness.auth.handle(message("/auth status"));

    expect(harness.send).toHaveBeenLastCalledWith(123, expect.stringContaining("could not be deleted"));
  });

  it("writes only validated input and rejects group auth without normal routing", async () => {
    const harness = makeHarness();
    await harness.auth.handle(message("/auth claude"));
    await harness.auth.handle(message("/auth input AB12-CD34"));
    await harness.auth.handle(message("/auth input bad-code"));
    await harness.auth.handle(message("/auth status", { chatType: "group" }));

    expect(harness.deleteMessage).toHaveBeenCalledWith(123, 7);
    expect(harness.pty.write).toHaveBeenCalledOnce();
    expect(harness.pty.write).toHaveBeenCalledWith("AB12-CD34\r");
    expect(harness.send).toHaveBeenCalledWith(123, expect.stringContaining("private"));
  });

  it("extracts only a Claude code from a loopback callback URL", async () => {
    const claude = makeHarness();
    const claudeCode = "Ab".repeat(24);
    await claude.auth.handle(message("/auth_claude"));
    await claude.auth.handle(message(`/auth_input http://localhost:58741/callback?code=${claudeCode}&state=state_1234567890123456`));
    expect(claude.pty.write).toHaveBeenCalledWith(`${claudeCode}\r`);

    const codex = makeHarness();
    await codex.auth.handle(message("/auth_codex"));
    await codex.auth.handle(message(`/auth_input http://localhost:58741/callback?code=${claudeCode}&state=state_1234567890123456`));
    expect(codex.pty.write).not.toHaveBeenCalled();
    expect(codex.send).toHaveBeenLastCalledWith(123, expect.stringContaining("only be used with /auth_claude"));
  });

  it("forwards each discovered URL and code once without retaining split UTF-8 bytes", async () => {
    const harness = makeHarness();
    await harness.auth.handle(message("/auth_codex"));
    harness.send.mockClear();
    harness.pty.emitData("Open https://auth.openai.com/device?state=secret-state Device code: ");
    harness.pty.emitData("AB12-Ж234");
    harness.pty.emitData(" Device code: AB12-CD34");

    expect(harness.send).toHaveBeenCalledTimes(2);
    expect(harness.send.mock.calls[0][1]).toContain("https://auth.openai.com/device?state=secret-state");
    expect(harness.send.mock.calls[1][1]).toContain("AB12-CD34");
  });

  it("requires a successful provider status after a zero exit", async () => {
    const harness = makeHarness();
    harness.run.mockResolvedValue({ stdout: JSON.stringify({ loggedIn: false }), exitCode: 0 });
    await harness.auth.handle(message("/auth claude"));
    harness.send.mockClear();
    harness.pty.emitExit(0);
    await new Promise((resolve) => setImmediate(resolve));

    expect(harness.send).toHaveBeenCalledWith(123, expect.stringContaining("failed"));
    expect(harness.send.mock.calls.flat().join(" ")).not.toMatch(/authenticated/i);
  });

  it("kills timed-out flows and does not send provider output", async () => {
    const harness = makeHarness();
    await harness.auth.handle(message("/auth_codex"));
    harness.pty.emitData("token=secret-value");
    harness.fireTimers();

    expect(harness.pty.kill).toHaveBeenCalledOnce();
    expect(harness.send).toHaveBeenLastCalledWith(123, expect.stringContaining("timed out"));
    expect(harness.send.mock.calls.flat().join(" ")).not.toContain("secret-value");
  });
});
