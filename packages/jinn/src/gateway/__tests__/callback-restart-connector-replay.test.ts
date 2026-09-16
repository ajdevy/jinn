import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector } from "../../shared/types.js";
import {
  acceptWithoutExecuting,
  api,
  eventually,
  makeContext,
  makeEngine,
  queueModule,
  registry,
  resetCallbackState,
} from "./helpers/callback-harness.js";
import { postCallbackDelivery } from "./helpers/callback-requests.js";

beforeEach(resetCallbackState);

describe("connector-parented callback restart replay", () => {
  it("replays as a fresh message after a repeated accept", async () => {
    const seenPrompts: string[] = [];
    const engine = makeEngine(seenPrompts);
    const sendMessage = vi.fn(async () => undefined);
    const replyMessage = vi.fn(async () => undefined);
    const target = { channel: "telegram-chat" };
    const connector = {
      id: "telegram",
      name: "telegram",
      reconstructTarget: vi.fn(() => target),
      sendMessage,
      replyMessage,
    } as unknown as Connector;
    const parent = registry.createSession({
      engine: "stub",
      source: "telegram",
      sourceRef: "telegram:callback-parent:connector-restart",
      sessionKey: "telegram:callback-parent:connector-restart",
      connector: "telegram",
      replyContext: { chatId: "telegram-chat", messageId: "stale-inbound" },
      prompt: "wait for child callbacks",
    });
    const delivery = registry.claimSessionDelivery({
      targetSessionId: parent.id,
      sourceKind: "session",
      sourceId: "child-connector-restart",
      sourceAttempt: "attempt-connector-restart-1",
      sourceOutcome: "succeeded",
      sourceVersion: 1,
      deliveryKind: "parent-completion",
      payload: { message: "connector callback after restart", displayMessage: "Connector restart result" },
    }).delivery;
    const preRestartQueue = acceptWithoutExecuting();
    await postCallbackDelivery(makeContext(engine, preRestartQueue), parent.id, delivery.id);
    await postCallbackDelivery(makeContext(engine, preRestartQueue), parent.id, delivery.id);

    const postRestartQueue = new queueModule.SessionQueue();
    const restoredContext = makeContext(engine, postRestartQueue);
    restoredContext.connectors = new Map([["telegram", connector]]);
    api.resumePendingWebQueueItems(restoredContext);

    await eventually(() => {
      expect(postRestartQueue.isRunning(parent.sessionKey)).toBe(false);
      expect(seenPrompts).toEqual(["connector callback after restart"]);
      expect(registry.listAllPendingQueueItems()).toEqual([]);
    });
    expect(sendMessage).toHaveBeenCalledWith(target, "acknowledged 1");
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(replyMessage).not.toHaveBeenCalled();
  });
});
