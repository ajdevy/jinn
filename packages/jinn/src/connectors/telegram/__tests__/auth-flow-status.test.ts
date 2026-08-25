import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fixtures from "./auth-flow-test-setup.js";

describe("AuthFlowManager status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports exact provider status lines and reuses the short-lived cache", async () => {
    const harness = fixtures.makeHarness();
    harness.verifyAuth.mockImplementation(async (provider: "claude" | "codex") => provider === "claude");

    await harness.manager.handleMessage(fixtures.message("/auth_status"));
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
    await harness.manager.handleMessage(fixtures.message("/auth_status"));
    expect(harness.send).toHaveBeenNthCalledWith(
      1,
      123,
      "No authentication flow is active.\nClaude: authenticated.\nCodex: not authenticated.",
    );
    expect(harness.verifyAuth).toHaveBeenCalledTimes(2);

    harness.advanceTime(5_001);
    harness.send.mockClear();
    await harness.manager.handleMessage(fixtures.message("/auth_status"));
    expect(harness.verifyAuth).toHaveBeenCalledTimes(4);
    expect(harness.send).toHaveBeenNthCalledWith(
      2,
      123,
      "No authentication flow is active.\nClaude: authenticated.\nCodex: not authenticated.",
    );
  });

  it("reports provider verification timeouts in status", async () => {
    const harness = fixtures.makeHarness();
    harness.verifyAuth.mockRejectedValue(
      Object.assign(new Error("timed out"), { timedOut: true }),
    );

    await harness.manager.handleMessage(fixtures.message("/auth_status"));

    expect(harness.send).toHaveBeenNthCalledWith(
      2,
      123,
      "No authentication flow is active.\nClaude: verification timed out.\nCodex: verification timed out.",
    );
  });

  it("refreshes cached provider status after an authentication flow completes", async () => {
    const harness = fixtures.makeHarness();
    harness.verifyAuth.mockResolvedValue(false);
    await harness.manager.handleMessage(fixtures.message("/auth_status"));

    harness.verifyAuth.mockImplementation(async (provider: "claude" | "codex") => provider === "claude");
    await harness.manager.handleMessage(fixtures.message("/auth claude"));
    harness.send.mockClear();
    harness.pty.emitExit({ exitCode: 0 });
    await fixtures.flushAsync();

    expect(harness.send).toHaveBeenCalledWith(
      123,
      "Claude authentication succeeded: authenticated.\nNext: authenticate Codex with /auth_codex.",
    );

    harness.send.mockClear();
    await harness.manager.handleMessage(fixtures.message("/auth_status"));
    expect(harness.send).toHaveBeenLastCalledWith(
      123,
      "No authentication flow is active.\nClaude: authenticated.\nCodex: not authenticated.",
    );
  });

});
