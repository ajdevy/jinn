import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fixtures from "./auth-flow-test-setup.js";

describe("AuthFlowManager lifecycle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("kills and clears the flow on timeout, cancel, and stop", async () => {
    const harness = fixtures.makeHarness();

    await harness.manager.handleMessage(fixtures.message("/auth claude"));
    harness.fireTimeout();
    expect(harness.ptys[0].kill).toHaveBeenCalledOnce();
    expect(harness.clock.clearTimeout).toHaveBeenCalled();
    expect(harness.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining("/auth_claude"),
    );

    await harness.manager.handleMessage(fixtures.message("/auth codex"));
    await harness.manager.handleMessage(fixtures.message("/auth cancel"));
    expect(harness.ptys[1].kill).toHaveBeenCalledOnce();
    expect(harness.send).toHaveBeenLastCalledWith(
      123,
      expect.stringContaining("cancel"),
    );

    await harness.manager.handleMessage(fixtures.message("/auth claude"));
    harness.manager.stop();
    expect(harness.ptys[2].kill).toHaveBeenCalledOnce();
  });
});
