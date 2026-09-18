import { describe, it, expect, vi, beforeEach } from "vitest";
import { deliverConnectorMessage, deliverConnectorReply, deliverLogChannelReply } from "../connector-reply.js";
import { logger } from "../../shared/logger.js";
import { __closeDbForTest } from "../../shared/db.js";
import type { Connector, JinnConfig, Session } from "../../shared/types.js";

/** Build a minimal mocked connector exposing the two methods the helper uses. */
function makeConnector(name: string) {
  const target = { channel: "C123", thread: "T1" };
  const reconstructTarget = vi.fn(() => target);
  const sendMessage = vi.fn(async () => undefined);
  const replyMessage = vi.fn(async () => undefined);
  const connector = { name, reconstructTarget, sendMessage, replyMessage } as unknown as Connector;
  return { connector, reconstructTarget, sendMessage, replyMessage, target };
}

/** Build the minimal slice of a Session the helper reads. */
function makeSession(
  overrides: Partial<Pick<Session, "source" | "connector" | "replyContext" | "attemptToken">> & { id?: string } = {},
): Pick<Session, "source" | "connector" | "replyContext" | "attemptToken"> & { id?: string } {
  return {
    source: "slack",
    connector: "slack",
    replyContext: { channel: "C123", ts: "1700000000.0001" },
    ...overrides,
  };
}

describe("deliverConnectorReply", () => {
  let map: Map<string, Connector>;
  let slack: ReturnType<typeof makeConnector>;

  beforeEach(() => {
    slack = makeConnector("slack");
    map = new Map<string, Connector>([["slack", slack.connector]]);
  });

  it("delivers a slack reply: reconstructTarget then replyMessage once", async () => {
    const session = makeSession();
    await deliverConnectorReply(session, "hello world", map);

    expect(slack.reconstructTarget).toHaveBeenCalledTimes(1);
    expect(slack.reconstructTarget).toHaveBeenCalledWith(session.replyContext);
    expect(slack.replyMessage).toHaveBeenCalledTimes(1);
    expect(slack.replyMessage).toHaveBeenCalledWith(slack.target, "hello world");
  });

  it("does not resend one terminal attempt when delivery is replayed three times", async () => {
    const session = makeSession({ id: "session-replay", attemptToken: "attempt-1" });

    await Promise.all([
      deliverConnectorReply(session, "hello world", map),
      deliverConnectorReply(session, "hello world", map),
      deliverConnectorReply(session, "hello world", map),
    ]);
    __closeDbForTest();
    await deliverConnectorReply(session, "hello world", map);

    expect(slack.replyMessage).toHaveBeenCalledOnce();
  });

  it("delivers an autonomous notification without replying to the stale inbound message", async () => {
    const session = makeSession();
    await deliverConnectorMessage(session, "background update", map);

    expect(slack.reconstructTarget).toHaveBeenCalledWith(session.replyContext);
    expect(slack.sendMessage).toHaveBeenCalledWith(slack.target, "background update");
    expect(slack.replyMessage).not.toHaveBeenCalled();
  });

  it("does not resend one autonomous notification when delivery is replayed", async () => {
    const session = makeSession({ id: "message-replay", attemptToken: "attempt-1" });

    await Promise.all([
      deliverConnectorMessage(session, "background update", map),
      deliverConnectorMessage(session, "background update", map),
      deliverConnectorMessage(session, "background update", map),
    ]);
    __closeDbForTest();
    await deliverConnectorMessage(session, "background update", map);

    expect(slack.sendMessage).toHaveBeenCalledOnce();
  });

  it("does not deliver for source 'web'", async () => {
    await deliverConnectorReply(makeSession({ source: "web" }), "hi", map);
    expect(slack.replyMessage).not.toHaveBeenCalled();
  });

  it("does not deliver for source 'cron'", async () => {
    await deliverConnectorReply(makeSession({ source: "cron" }), "hi", map);
    expect(slack.replyMessage).not.toHaveBeenCalled();
  });

  it("does not deliver for source 'talk'", async () => {
    await deliverConnectorReply(makeSession({ source: "talk" }), "hi", map);
    expect(slack.replyMessage).not.toHaveBeenCalled();
  });

  it("delivers to a named connector instance keyed by instance id", async () => {
    const support = makeConnector("slack");
    const named = new Map<string, Connector>([["slack-support", support.connector]]);
    await deliverConnectorReply(makeSession({ connector: "slack-support" }), "hi", named);
    expect(support.reconstructTarget).toHaveBeenCalledTimes(1);
    expect(support.replyMessage).toHaveBeenCalledTimes(1);
  });

  it("logs a warning and does not call when connector missing from map", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const session = makeSession({ id: "sess-42", connector: "telegram", source: "telegram" });
    await expect(deliverConnectorReply(session, "hi", map)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("sess-42");
    expect(warn.mock.calls[0][0]).toContain("telegram");
    expect(slack.replyMessage).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not deliver when text is empty", async () => {
    await deliverConnectorReply(makeSession(), "", map);
    expect(slack.replyMessage).not.toHaveBeenCalled();
  });

  it("does not deliver when replyContext is missing", async () => {
    await deliverConnectorReply(makeSession({ replyContext: null }), "hi", map);
    expect(slack.replyMessage).not.toHaveBeenCalled();
  });

  it("swallows connector errors (does not reject)", async () => {
    slack.replyMessage.mockRejectedValueOnce(new Error("boom"));
    await expect(deliverConnectorReply(makeSession(), "hi", map)).resolves.toBeUndefined();
  });
});

describe("deliverLogChannelReply", () => {
  let map: Map<string, Connector>;
  let slack: ReturnType<typeof makeConnector>;
  let telegram: ReturnType<typeof makeConnector>;

  beforeEach(() => {
    slack = makeConnector("slack");
    telegram = makeConnector("telegram");
    map = new Map<string, Connector>([["slack", slack.connector], ["telegram", telegram.connector]]);
  });

  it("does nothing when logChannel is unset (documented fallback)", async () => {
    const session = makeSession();
    await deliverLogChannelReply(session, "done", map, {} as Pick<JinnConfig, "notifications">);
    expect(slack.sendMessage).not.toHaveBeenCalled();
  });

  it("sends to the session's own connector, on logChannel, when logConnector is unset", async () => {
    const session = makeSession();
    await deliverLogChannelReply(session, "done", map, { notifications: { logChannel: "log-1" } });
    expect(slack.sendMessage).toHaveBeenCalledWith({ channel: "log-1" }, "done");
    expect(slack.replyMessage).not.toHaveBeenCalled();
  });

  it("sends to an explicit logConnector distinct from the session's own connector", async () => {
    const session = makeSession({ connector: "slack" });
    await deliverLogChannelReply(session, "done", map, {
      notifications: { logConnector: "telegram", logChannel: "-1000" },
    });
    expect(telegram.sendMessage).toHaveBeenCalledWith({ channel: "-1000" }, "done");
    expect(slack.sendMessage).not.toHaveBeenCalled();
  });

  it("logs a warning and no-ops when the configured logConnector is not registered", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const session = makeSession({ id: "sess-log-1" });
    await deliverLogChannelReply(session, "done", map, {
      notifications: { logConnector: "discord", logChannel: "-1000" },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("sess-log-1");
    expect(warn.mock.calls[0][0]).toContain("discord");
    warn.mockRestore();
  });

  it("does not deliver when text is empty", async () => {
    await deliverLogChannelReply(makeSession(), "", map, { notifications: { logChannel: "log-1" } });
    expect(slack.sendMessage).not.toHaveBeenCalled();
  });

  it("does not resend one terminal log delivery when replayed three times", async () => {
    const session = makeSession({ id: "log-replay", attemptToken: "attempt-1" });
    const config: Pick<JinnConfig, "notifications"> = { notifications: { logChannel: "log-1" } };

    await Promise.all([
      deliverLogChannelReply(session, "done", map, config),
      deliverLogChannelReply(session, "done", map, config),
      deliverLogChannelReply(session, "done", map, config),
    ]);
    __closeDbForTest();
    await deliverLogChannelReply(session, "done", map, config);

    expect(slack.sendMessage).toHaveBeenCalledOnce();
  });

  it("swallows connector errors (does not reject)", async () => {
    slack.sendMessage.mockRejectedValueOnce(new Error("boom"));
    await expect(
      deliverLogChannelReply(makeSession(), "done", map, { notifications: { logChannel: "log-1" } }),
    ).resolves.toBeUndefined();
  });
});
