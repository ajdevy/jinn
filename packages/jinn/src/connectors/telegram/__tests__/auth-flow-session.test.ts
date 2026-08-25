import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fixtures from "./auth-flow-test-setup.js";

describe("AuthFlowManager sessions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("consumes underscore sensitive-input variants without writing them to a session", async () => {
    const harness = fixtures.makeHarness();

    await expect(
      harness.manager.handleMessage(fixtures.message("/auth_input AB12-CD34")),
    ).resolves.toBe(true);
    await expect(
      harness.manager.handleMessage(fixtures.message("/auth_token secret-value")),
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
    const harness = fixtures.makeHarness();

    await harness.manager.handleMessage(fixtures.message("/auth claude"));
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
    await harness.manager.handleMessage(fixtures.message("/auth cancel"));
    await harness.manager.handleMessage(fixtures.message("/auth codex"));
    expect(harness.spawnPty).toHaveBeenCalledWith(
      "codex",
      ["login", "--device-auth"],
      expect.anything(),
    );
    const argv = harness.spawnPty.mock.calls.flatMap((call: any) => call[1]);
    expect(argv.some((arg: any) => /token|secret|oauth/i.test(arg))).toBe(false);
  });

  it("keeps provider flows independent and reports all active providers", async () => {
    const harness = fixtures.makeHarness();

    await harness.manager.handleMessage(fixtures.message("/auth claude"));
    await harness.manager.handleMessage(fixtures.message("/auth codex"));

    expect(harness.spawnPty).toHaveBeenCalledTimes(2);
    expect(harness.ptys[0].kill).not.toHaveBeenCalled();
    expect(harness.ptys[1].kill).not.toHaveBeenCalled();
    await harness.manager.handleMessage(fixtures.message("/auth status"));
    expect(harness.send).toHaveBeenLastCalledWith(
      123,
      expect.stringContaining("Claude"),
    );
    expect(harness.send.mock.calls.at(-1)?.[1]).toContain("Codex");
  });

  it("replaces only the same provider and ignores stale callbacks", async () => {
    const harness = fixtures.makeHarness();

    await harness.manager.handleMessage(fixtures.message("/auth claude"));
    await harness.manager.handleMessage(fixtures.message("/auth codex"));
    await harness.manager.handleMessage(fixtures.message("/auth claude"));

    expect(harness.ptys[0].kill).toHaveBeenCalledOnce();
    expect(harness.ptys[1].kill).not.toHaveBeenCalled();

    harness.send.mockClear();
    harness.ptys[0].emitData("Open https://stale.example.test/login");
    harness.ptys[0].emitExit({ exitCode: 0 });
    await Promise.resolve();
    expect(harness.send).not.toHaveBeenCalled();

    await harness.manager.handleMessage(fixtures.message("/auth cancel"));
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
    const harness = fixtures.makeHarness();

    await harness.manager.handleMessage(fixtures.message("/auth claude"));
    await harness.manager.handleMessage(fixtures.message("/auth codex"));
    harness.send.mockClear();

    await harness.manager.handleMessage(fixtures.message("/auth input AB12-CD34"));

    expect(harness.ptys[0].write).not.toHaveBeenCalled();
    expect(harness.ptys[1].write).not.toHaveBeenCalled();
    expect(harness.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining("ambiguous"),
    );
  });

  it("isolates active flows by canonical owner ID and provider", async () => {
    const secondOwner = 4242424242;
    const harness = fixtures.makeHarness({
      ownerUserIds: [5658965359, secondOwner],
    });

    await harness.manager.handleMessage(fixtures.message("/auth claude"));
    await harness.manager.handleMessage(
      fixtures.message("/auth claude", {
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
      fixtures.message("/auth status", {
        userId: String(secondOwner),
        chatId: 456,
      }),
    );
    expect(harness.send).toHaveBeenLastCalledWith(
      456,
      expect.stringContaining("Claude"),
    );
    await harness.manager.handleMessage(fixtures.message("/auth status"));
    expect(harness.send).toHaveBeenLastCalledWith(
      123,
      expect.stringContaining("Claude"),
    );

    await harness.manager.handleMessage(fixtures.message("/auth input AB12-CD34"));
    expect(harness.ptys[0].write).toHaveBeenCalledWith("AB12-CD34\r");
    expect(harness.ptys[1].write).not.toHaveBeenCalled();

    await harness.manager.handleMessage(
      fixtures.message("/auth input ZX12-AB34", {
        userId: String(secondOwner),
        chatId: 456,
        messageId: 10,
      }),
    );
    expect(harness.ptys[1].write).toHaveBeenCalledWith("ZX12-AB34\r");

    await harness.manager.handleMessage(
      fixtures.message("/auth cancel", {
        userId: 5658965359,
        chatId: 123,
      }),
    );
    expect(harness.ptys[0].kill).toHaveBeenCalledOnce();
    expect(harness.ptys[1].kill).not.toHaveBeenCalled();

    await harness.manager.handleMessage(
      fixtures.message("/auth cancel", {
        userId: String(secondOwner),
        chatId: 456,
        messageId: 9,
      }),
    );
    expect(harness.ptys[1].kill).toHaveBeenCalledOnce();
  });

});
