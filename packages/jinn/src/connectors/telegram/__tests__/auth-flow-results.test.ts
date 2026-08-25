import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fixtures from "./auth-flow-test-setup.js";

describe("AuthFlowManager results", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports generic success and failure based only on exit status", async () => {
    const harness = fixtures.makeHarness();

    await harness.manager.handleMessage(fixtures.message("/auth claude"));
    harness.send.mockClear();
    harness.pty.emitExit({ exitCode: 0 });
    await fixtures.flushAsync();
    expect(harness.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining("authenticated"),
    );

    await harness.manager.handleMessage(fixtures.message("/auth codex"));
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
    const harness = fixtures.makeHarness();
    harness.verifyAuth.mockImplementation(async (provider: "claude" | "codex") => provider === "claude");

    await harness.manager.handleMessage(fixtures.message("/auth claude"));
    harness.send.mockClear();
    harness.pty.emitExit({ exitCode: 0 });
    await fixtures.flushAsync();

    expect(harness.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining("/auth_codex"),
    );
  });

  it("does not offer Codex when it is already authenticated", async () => {
    const harness = fixtures.makeHarness();

    await harness.manager.handleMessage(fixtures.message("/auth claude"));
    harness.send.mockClear();
    harness.pty.emitExit({ exitCode: 0 });
    await fixtures.flushAsync();

    expect(harness.send).toHaveBeenCalledWith(
      123,
      "Claude authentication succeeded: authenticated.",
    );
  });

  it("does not offer Codex when a Codex flow is already running", async () => {
    const harness = fixtures.makeHarness();
    harness.verifyAuth.mockImplementation(async (provider: "claude" | "codex") => provider === "claude");

    await harness.manager.handleMessage(fixtures.message("/auth claude"));
    await harness.manager.handleMessage(fixtures.message("/auth codex"));
    harness.send.mockClear();
    harness.ptys[0].emitExit({ exitCode: 0 });
    await fixtures.flushAsync();

    expect(harness.send).toHaveBeenCalledWith(
      123,
      "Claude authentication succeeded: authenticated.",
    );
    expect(harness.ptys[1].kill).not.toHaveBeenCalled();
  });

  it("requires post-exit verification before reporting authentication success", async () => {
    const harness = fixtures.makeHarness();

    harness.verifyAuth.mockResolvedValueOnce(false);
    await harness.manager.handleMessage(fixtures.message("/auth claude"));
    harness.send.mockClear();
    harness.pty.emitExit({ exitCode: 0 });
    await fixtures.flushAsync();

    expect(harness.verifyAuth).toHaveBeenCalledWith("claude");
    expect(harness.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining("failed"),
    );
    expect(harness.send.mock.calls.flat().join(" ")).not.toMatch(/authenticated/i);
  });

  it("fails closed when the post-exit verifier is missing", async () => {
    const harness = fixtures.makeHarness({ withVerifier: false });

    await harness.manager.handleMessage(fixtures.message("/auth codex"));
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
    const harness = fixtures.makeHarness({ verifyTimeoutSeconds: 1 });
    harness.verifyAuth.mockReturnValueOnce(new Promise<boolean>(() => {}));

    await harness.manager.handleMessage(fixtures.message("/auth claude"));
    harness.send.mockClear();
    harness.pty.emitExit({ exitCode: 0 });
    await Promise.resolve();

    harness.fireTimeout();
    await fixtures.flushAsync();

    expect(harness.verifyAuth).toHaveBeenCalledWith("claude");
    expect(harness.send).toHaveBeenCalledWith(
      123,
      "Claude authentication verification timed out. Try again with /auth_claude.",
    );
    expect(harness.send.mock.calls.flat().join(" ")).toContain("/auth_claude");
    expect(harness.send.mock.calls.flat().join(" ")).not.toMatch(/authenticated/i);

    harness.send.mockClear();
    await harness.manager.handleMessage(fixtures.message("/auth status"));
    expect(harness.send).toHaveBeenCalledWith(
      123,
      "No authentication flow is active.\nClaude: verification timed out.\nCodex: authenticated.",
    );
  });

});
