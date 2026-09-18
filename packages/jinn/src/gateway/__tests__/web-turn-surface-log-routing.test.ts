import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Connector, JinnConfig } from "../../shared/types.js";

const deliverConnectorReply = vi.fn(async (..._args: unknown[]) => {});
const deliverConnectorMessage = vi.fn(async (..._args: unknown[]) => {});
const deliverLogChannelReply = vi.fn(async (..._args: unknown[]) => {});

vi.mock("../connector-reply.js", () => ({
  deliverConnectorReply: (...args: unknown[]) => deliverConnectorReply(...args),
  deliverConnectorMessage: (...args: unknown[]) => deliverConnectorMessage(...args),
  deliverLogChannelReply: (...args: unknown[]) => deliverLogChannelReply(...args),
}));

type Registry = typeof import("../../sessions/registry.js");
type WebTurnSurfaceModule = typeof import("../web-turn-surface.js");

let createSession: Registry["createSession"];
let createWebTurnSurface: WebTurnSurfaceModule["createWebTurnSurface"];

// vitest's global setup already isolates JINN_HOME per worker (see
// vitest.setup.ts), so a plain dynamic import is enough here — same as
// connector-reply's own test file.
beforeEach(async () => {
  vi.clearAllMocks();
  ({ createSession } = await import("../../sessions/registry.js"));
  ({ createWebTurnSurface } = await import("../web-turn-surface.js"));
});

function baseConfig(overrides: Partial<NonNullable<JinnConfig["notifications"]>> = {}): JinnConfig {
  return { notifications: { ...overrides } } as unknown as JinnConfig;
}

describe("createWebTurnSurface reply() log-channel routing", () => {
  it("routes a routine notification-triggered reply to the log channel when configured", async () => {
    const session = createSession({ engine: "claude", source: "telegram", sourceRef: "chat-1", connector: "telegram" });
    const surface = createWebTurnSurface({
      sessionId: session.id,
      emit: vi.fn(),
      connectors: new Map<string, Connector>(),
      getConfig: () => baseConfig({ logChannel: "-1000" }),
      triggerKind: "notification",
    });

    await surface.reply("Task done, PR merged.");

    expect(deliverLogChannelReply).toHaveBeenCalledTimes(1);
    expect(deliverConnectorReply).not.toHaveBeenCalled();
    expect(deliverConnectorMessage).not.toHaveBeenCalled();
  });

  it("keeps the primary target when logChannel is unset (documented fallback)", async () => {
    const session = createSession({ engine: "claude", source: "telegram", sourceRef: "chat-2", connector: "telegram" });
    const surface = createWebTurnSurface({
      sessionId: session.id,
      emit: vi.fn(),
      connectors: new Map<string, Connector>(),
      getConfig: () => baseConfig(),
      triggerKind: "notification",
    });

    await surface.reply("Task done, PR merged.");

    expect(deliverLogChannelReply).not.toHaveBeenCalled();
    expect(deliverConnectorReply).toHaveBeenCalledTimes(1);
  });

  it("keeps the primary target for an operator-triggered turn even with logChannel configured", async () => {
    const session = createSession({ engine: "claude", source: "telegram", sourceRef: "chat-3", connector: "telegram" });
    const surface = createWebTurnSurface({
      sessionId: session.id,
      emit: vi.fn(),
      connectors: new Map<string, Connector>(),
      getConfig: () => baseConfig({ logChannel: "-1000" }),
      triggerKind: "operator",
    });

    await surface.reply("Task done, PR merged.");

    expect(deliverLogChannelReply).not.toHaveBeenCalled();
    expect(deliverConnectorReply).toHaveBeenCalledTimes(1);
  });

  it("keeps the primary target for a notification-triggered turn carrying an explicit question", async () => {
    const session = createSession({ engine: "claude", source: "telegram", sourceRef: "chat-4", connector: "telegram" });
    const surface = createWebTurnSurface({
      sessionId: session.id,
      emit: vi.fn(),
      connectors: new Map<string, Connector>(),
      getConfig: () => baseConfig({ logChannel: "-1000" }),
      triggerKind: "notification",
    });

    await surface.reply("Should I merge this PR now?");

    expect(deliverLogChannelReply).not.toHaveBeenCalled();
    expect(deliverConnectorReply).toHaveBeenCalledTimes(1);
  });

  it("keeps the primary target for a notification-triggered turn reporting a blocker", async () => {
    const session = createSession({ engine: "claude", source: "telegram", sourceRef: "chat-5", connector: "telegram" });
    const surface = createWebTurnSurface({
      sessionId: session.id,
      emit: vi.fn(),
      connectors: new Map<string, Connector>(),
      getConfig: () => baseConfig({ logChannel: "-1000" }),
      triggerKind: "notification",
    });

    await surface.reply("Blocked on missing deploy credentials.");

    expect(deliverLogChannelReply).not.toHaveBeenCalled();
    expect(deliverConnectorReply).toHaveBeenCalledTimes(1);
  });

  it("routes an autonomous (replyToMessage: false) routine notification to the log channel too", async () => {
    const session = createSession({ engine: "claude", source: "telegram", sourceRef: "chat-6", connector: "telegram" });
    const surface = createWebTurnSurface({
      sessionId: session.id,
      emit: vi.fn(),
      connectors: new Map<string, Connector>(),
      getConfig: () => baseConfig({ logChannel: "-1000" }),
      triggerKind: "notification",
      replyToMessage: false,
    });

    await surface.reply("Still working, no blockers.");

    expect(deliverLogChannelReply).toHaveBeenCalledTimes(1);
    expect(deliverConnectorMessage).not.toHaveBeenCalled();
  });
});
