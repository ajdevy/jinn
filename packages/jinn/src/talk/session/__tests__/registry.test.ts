import { describe, expect, it } from "vitest";
import { TALK_SESSION_TTL_MS, TalkSessionError, TalkSessionRegistry } from "../registry.js";

/** An injected clock, so the reaper is tested against elapsed time rather than
 *  against how long the test suite is willing to sleep. */
function clockAt(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return { now: () => value, advance: (ms: number) => { value += ms; } };
}

function openOne(registry: TalkSessionRegistry) {
  return registry.open({ sessionId: "row-1", model: "gpt-realtime-2.1", tokenExpiresAt: 1_700_000_600 });
}

describe("TalkSessionRegistry lifecycle", () => {
  it("opens live and carries only the always-on tools", () => {
    const registry = new TalkSessionRegistry(clockAt().now);
    const session = openOne(registry);
    expect(session.state).toBe("live");
    expect(session.exposedTools).toEqual(["search_knowledge", "hand_off_to_chat"]);
    expect(session.expandedIntents).toEqual([]);
  });

  it("survives repeated reads without being bound to anything", () => {
    const registry = new TalkSessionRegistry(clockAt().now);
    const session = openOne(registry);
    registry.appendTurn(session.id, "how are the todos looking");
    for (let i = 0; i < 3; i += 1) {
      const seen = registry.get(session.id);
      expect(seen?.id).toBe(session.id);
      expect(seen?.state).toBe("live");
      expect(seen?.turns).toHaveLength(1);
    }
  });

  it("moves live to parked and back", () => {
    const registry = new TalkSessionRegistry(clockAt().now);
    const session = openOne(registry);
    expect(registry.park(session.id).state).toBe("parked");
    expect(registry.resume(session.id).state).toBe("live");
  });

  it("rejects a park on a parked session and a resume on a live one with 409", () => {
    const registry = new TalkSessionRegistry(clockAt().now);
    const session = openOne(registry);
    expect(() => registry.resume(session.id)).toThrow(TalkSessionError);
    expect(() => registry.resume(session.id)).toThrow(/already live/i);
    registry.park(session.id);
    try {
      registry.park(session.id);
      expect.unreachable("park on a parked session must throw");
    } catch (error) {
      expect((error as TalkSessionError).status).toBe(409);
    }
  });

  it("reports an unknown id as 404 rather than inventing a session", () => {
    const registry = new TalkSessionRegistry(clockAt().now);
    expect(registry.get("nope")).toBeUndefined();
    try {
      registry.park("nope");
      expect.unreachable("park on an unknown id must throw");
    } catch (error) {
      expect((error as TalkSessionError).status).toBe(404);
    }
  });

  it("closes idempotently", () => {
    const registry = new TalkSessionRegistry(clockAt().now);
    const session = openOne(registry);
    registry.close(session.id);
    registry.close(session.id);
    expect(registry.get(session.id)).toBeUndefined();
  });
});

describe("TalkSessionRegistry reaper", () => {
  it("closes a session that stopped heartbeating and spares one that did not", () => {
    const clock = clockAt();
    const registry = new TalkSessionRegistry(clock.now);
    const abandoned = registry.open({ sessionId: "row-abandoned", model: "gpt-realtime-2.1", tokenExpiresAt: 1_700_000_600 });
    const alive = registry.open({ sessionId: "row-alive", model: "gpt-realtime-2.1", tokenExpiresAt: 1_700_000_600 });

    clock.advance(TALK_SESSION_TTL_MS / 2);
    registry.heartbeat(alive.id);
    clock.advance(TALK_SESSION_TTL_MS / 2 + 1);
    registry.heartbeat(alive.id);

    expect(registry.reap()).toEqual([abandoned.id]);
    expect(registry.get(abandoned.id)).toBeUndefined();
    expect(registry.get(alive.id)?.state).toBe("live");
  });

  it("reaps a parked session too — a closed tab stops heartbeating either way", () => {
    const clock = clockAt();
    const registry = new TalkSessionRegistry(clock.now);
    const session = openOne(registry);
    registry.park(session.id);
    clock.advance(TALK_SESSION_TTL_MS + 1);
    expect(registry.reap()).toEqual([session.id]);
  });
});

describe("TalkSessionRegistry turns and tools", () => {
  it("truncates oldest-first, counts what it dropped, and keeps the newest turn", () => {
    const registry = new TalkSessionRegistry(clockAt().now);
    const session = openOne(registry);
    // 400 tokens per turn against a 1000-token budget: the third turn evicts the first.
    const turn = "x".repeat(1600);

    expect(registry.appendTurn(session.id, turn, 1000).truncatedTurns).toBe(0);
    expect(registry.appendTurn(session.id, turn, 1000).truncatedTurns).toBe(0);
    const third = registry.appendTurn(session.id, `${turn}!`, 1000);

    expect(third.truncatedTurns).toBe(1);
    const kept = registry.get(session.id)!.turns;
    expect(kept).toHaveLength(2);
    expect(kept.at(-1)!.text).toBe(`${turn}!`);
  });

  it("always keeps the newest turn even when it alone exceeds the budget", () => {
    const registry = new TalkSessionRegistry(clockAt().now);
    const session = openOne(registry);
    const result = registry.appendTurn(session.id, "x".repeat(40_000), 1000);
    expect(registry.get(session.id)!.turns).toHaveLength(1);
    expect(result.handoffSuggested).toBe(true);
  });

  it("adds an intent's tools once and nothing the second time", () => {
    const registry = new TalkSessionRegistry(clockAt().now);
    const session = openOne(registry);

    const first = registry.exposeTools(session.id, ["todos"]);
    expect(first.map((tool) => tool.name)).toEqual(["list_work_items", "get_work_item"]);

    const second = registry.exposeTools(session.id, ["todos"]);
    expect(second).toEqual([]);
    expect(registry.get(session.id)!.exposedTools).toHaveLength(4);
  });

  it("refuses turns and tool expansion on a closed session", () => {
    const registry = new TalkSessionRegistry(clockAt().now);
    const session = openOne(registry);
    registry.close(session.id);
    expect(() => registry.appendTurn(session.id, "hello")).toThrow(TalkSessionError);
    expect(() => registry.exposeTools(session.id, ["todos"])).toThrow(TalkSessionError);
  });
});
