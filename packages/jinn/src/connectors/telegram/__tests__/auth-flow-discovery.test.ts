import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fixtures from "./auth-flow-test-setup.js";

describe("AuthFlowManager discovery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes the input message and writes only a validated short code to the PTY", async () => {
    const harness = fixtures.makeHarness();

    await harness.manager.handleMessage(fixtures.message("/auth claude"));
    await harness.manager.handleMessage(fixtures.message("/auth input AB12-CD34"));

    expect(harness.deleteMessage).toHaveBeenCalledWith(123, 7);
    expect(harness.pty.write).toHaveBeenCalledWith("AB12-CD34\r");
    expect(harness.pty.write).toHaveBeenCalledOnce();

    harness.deleteMessage.mockRejectedValueOnce(new Error("telegram failure"));
    await expect(
      harness.manager.handleMessage(fixtures.message("/auth input bad-code")),
    ).resolves.toBe(true);
    expect(harness.pty.write).toHaveBeenCalledOnce();
  });

  it("sends an extracted URL and device code once without logging PTY output", async () => {
    const harness = fixtures.makeHarness();

    await harness.manager.handleMessage(fixtures.message("/auth codex"));
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
    const harness = fixtures.makeHarness();
    const url = "https://auth.openai.com/device?state=oversized-state";
    const code = "OVSZ-1234";

    await harness.manager.handleMessage(fixtures.message("/auth codex"));
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
    const harness = fixtures.makeHarness();

    await harness.manager.handleMessage(fixtures.message("/auth codex"));
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
    await fixtures.flushAsync();

    expect(harness.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining("https://auth.openai.com/device?state=final-state"),
    );
    expect(harness.send.mock.calls.flat().join(" ")).toContain("ZX12-AB34");
  });

});
