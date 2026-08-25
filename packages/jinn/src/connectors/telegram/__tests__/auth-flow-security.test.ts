import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fixtures from "./auth-flow-test-setup.js";

describe("AuthFlowManager security", () => {
  beforeEach(() => vi.clearAllMocks());

  it("consumes auth commands from a non-owner without spawning or disclosing auth", async () => {
    const harness = fixtures.makeHarness();

    await expect(
      harness.manager.handleMessage(fixtures.message("/auth claude", { userId: 999999 })),
    ).resolves.toBe(true);

    expect(harness.spawnPty).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("deletes sensitive auth text from an allow-listed non-owner", async () => {
    const harness = fixtures.makeHarness();

    await expect(
      harness.manager.handleMessage(
        fixtures.message("/auth_token=secret-value", { userId: 999999 }),
      ),
    ).resolves.toBe(true);

    expect(harness.deleteMessage).toHaveBeenCalledWith(123, 7);
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.spawnPty).not.toHaveBeenCalled();
  });

  it("deletes sensitive auth text from an allow-listed non-owner in a group", async () => {
    const harness = fixtures.makeHarness();

    await expect(
      harness.manager.handleMessage(
        fixtures.message("/auth_token=secret-value", {
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
    const harness = fixtures.makeHarness({ ownerUserIds: [] });

    await expect(
      harness.manager.handleMessage(
        fixtures.message("/auth_token=secret-value", { userId: 999999 }),
      ),
    ).resolves.toBe(true);

    expect(harness.deleteMessage).toHaveBeenCalledWith(123, 7);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("does not delete a non-owner payload when non-owner scrubbing is disabled", async () => {
    const harness = fixtures.makeHarness({ deleteSensitiveInputFromNonOwners: false });

    await expect(
      harness.manager.handleMessage(
        fixtures.message("/auth_token=secret-value", { userId: 999999 }),
      ),
    ).resolves.toBe(true);

    expect(harness.deleteMessage).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("leaves unrelated auth-prefixed text for the normal message handler", async () => {
    const harness = fixtures.makeHarness();

    await expect(
      harness.manager.handleMessage(fixtures.message("/auth_notes: buy milk")),
    ).resolves.toBe(false);

    expect(harness.deleteMessage).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.spawnPty).not.toHaveBeenCalled();
  });

  it("warns when a sensitive auth message cannot be deleted", async () => {
    const harness = fixtures.makeHarness();
    harness.deleteMessage.mockRejectedValueOnce(new Error("telegram failure"));

    await harness.manager.handleMessage(fixtures.message("/auth_token=secret-value"));

    expect(harness.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining("could not be deleted"),
    );

    harness.send.mockClear();
    await harness.manager.handleMessage(fixtures.message("/auth claude"));
    harness.deleteMessage.mockRejectedValueOnce(new Error("telegram failure"));
    await harness.manager.handleMessage(fixtures.message("/auth input AB12-CD34"));
    expect(harness.send).toHaveBeenCalledWith(
      123,
      "Warning: the message could not be deleted. Remove it manually.",
    );
    expect(harness.pty.write).toHaveBeenCalledWith("AB12-CD34\r");
  });

  it("keeps a non-owner silent when a group secret cannot be deleted", async () => {
    const harness = fixtures.makeHarness();
    harness.deleteMessage.mockRejectedValueOnce(new Error("telegram failure"));

    await harness.manager.handleMessage(
      fixtures.message("/auth_token=secret-value", {
        userId: 999999,
        chatType: "group",
      }),
    );

    expect(harness.send).not.toHaveBeenCalled();
  });

  it("rejects auth commands from non-private chats before spawning", async () => {
    const harness = fixtures.makeHarness();

    await expect(
      harness.manager.handleMessage(fixtures.message("/auth claude", { chatType: "group" })),
    ).resolves.toBe(true);

    expect(harness.spawnPty).not.toHaveBeenCalled();
    expect(harness.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining("private"),
    );
  });

  it("routes menu command forms through the auth handler", async () => {
    const harness = fixtures.makeHarness();

    await harness.manager.handleMessage(fixtures.message("/auth_claude"));
    expect(harness.spawnPty).toHaveBeenCalledWith(
      "claude",
      ["auth", "login", "--claudeai"],
      expect.anything(),
    );

    harness.send.mockClear();
    await harness.manager.handleMessage(fixtures.message("/auth_status"));
    expect(harness.send).toHaveBeenCalledWith(
      123,
      expect.stringContaining("Claude"),
    );

    await harness.manager.handleMessage(fixtures.message("/auth_cancel"));
    expect(harness.pty.kill).toHaveBeenCalledOnce();
  });

  it("does not delete bare authentication commands", async () => {
    const harness = fixtures.makeHarness();

    await harness.manager.handleMessage(fixtures.message("/auth claude"));
    await harness.manager.handleMessage(fixtures.message("/auth_status"));
    await harness.manager.handleMessage(fixtures.message("/auth cancel"));

    expect(harness.deleteMessage).not.toHaveBeenCalled();
  });

  it("consumes equals-separated auth commands before the normal agent handler", async () => {
    const harness = fixtures.makeHarness();

    await expect(
      harness.manager.handleMessage(fixtures.message("/auth_token=secret-value")),
    ).resolves.toBe(true);
    await expect(
      harness.manager.handleMessage(fixtures.message("/auth_api_key=secret-value")),
    ).resolves.toBe(true);
    await expect(
      harness.manager.handleMessage(fixtures.message("/auth_access-token=secret-value")),
    ).resolves.toBe(true);
    await expect(
      harness.manager.handleMessage(fixtures.message("/auth_token: secret-value")),
    ).resolves.toBe(true);
    await expect(
      harness.manager.handleMessage(fixtures.message("/auth_input=AB12-CD34")),
    ).resolves.toBe(true);
    await expect(
      harness.manager.handleMessage(fixtures.message("/auth token secret-value\nsecond line")),
    ).resolves.toBe(true);
    await expect(
      harness.manager.handleMessage(
        fixtures.message("/auth_token=secret-value", { chatType: "group" }),
      ),
    ).resolves.toBe(true);

    expect(harness.deleteMessage).toHaveBeenCalledTimes(7);
    expect(harness.spawnPty).not.toHaveBeenCalled();
    expect(harness.send.mock.calls.flat().join(" ")).not.toContain("secret-value");
  });

});
