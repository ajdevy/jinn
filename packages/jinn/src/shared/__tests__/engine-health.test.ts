import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JinnConfig } from "../types.js";

// The store freezes its path from JINN_HOME at import, and the run's shared temp
// home would let a suite in another worker see — or clear — these records.
const TEST_HOME = path.join(os.tmpdir(), "jinn-engine-health-test");
vi.mock("../paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../paths.js")>()),
  JINN_HOME: path.join(os.tmpdir(), "jinn-engine-health-test"),
}));

import {
  isEngineExhausted,
  preferHealthySessionEngine,
  readEngineHealth,
  recordEngineUnavailable,
  recordExhaustedWindows,
  resolveHealthyFallbackEngine,
} from "../engine-health.js";

const STATE_PATH = path.join(TEST_HOME, "tmp", "engine-health.json");
const NOW = new Date("2026-08-19T10:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
/** Unix seconds, which is the unit every caller carries a stated reset in. */
const secondsAt = (minutes: number) => at(minutes).getTime() / 1000;

beforeEach(() => {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.rmSync(STATE_PATH, { force: true });
});

afterEach(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("recordEngineUnavailable", () => {
  it("records an engine exhausted until the reset it stated", () => {
    recordEngineUnavailable("codex", "out of quota", secondsAt(90), NOW);

    expect(readEngineHealth(NOW).codex).toEqual({
      state: "exhausted",
      until: at(90).toISOString(),
      reason: "out of quota",
      observedAt: NOW.toISOString(),
    });
  });

  it("records a failure that stated no reset as degraded, which never blocks", () => {
    recordEngineUnavailable("codex", "unreachable", undefined, NOW);

    expect(readEngineHealth(NOW).codex?.state).toBe("degraded");
    expect(isEngineExhausted(readEngineHealth(NOW), "codex")).toBe(false);
  });

  it("clamps a reset further out than twelve hours rather than storing it verbatim", () => {
    recordEngineUnavailable("codex", "out of quota", secondsAt(3 * 24 * 60), NOW);

    expect(readEngineHealth(NOW).codex?.until).toBe(at(12 * 60).toISOString());
  });

  it("keeps one record per engine", () => {
    recordEngineUnavailable("codex", "out of quota", secondsAt(90), NOW);
    recordEngineUnavailable("claude", "rate-limited", secondsAt(30), NOW);

    expect(Object.keys(readEngineHealth(NOW)).sort()).toEqual(["claude", "codex"]);
  });
});

describe("readEngineHealth", () => {
  it("reads a record back as ok once the window it stated has passed", () => {
    recordEngineUnavailable("codex", "out of quota", secondsAt(90), NOW);

    expect(readEngineHealth(at(89)).codex?.state).toBe("exhausted");
    expect(readEngineHealth(at(91)).codex?.state).toBe("ok");
    // Nothing swept: the record on disk is untouched, the clock decided.
    expect(JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")).codex.state).toBe("exhausted");
  });

  it("reports nothing for an engine no failure has been observed on", () => {
    expect(readEngineHealth(NOW).codex).toBeUndefined();
    expect(isEngineExhausted(readEngineHealth(NOW), "codex")).toBe(false);
  });

  it("ignores a store that is corrupt or holds a state it does not know", () => {
    fs.writeFileSync(STATE_PATH, "{not json");
    expect(readEngineHealth(NOW)).toEqual({});

    fs.writeFileSync(STATE_PATH, JSON.stringify({ codex: { state: "on fire" }, claude: null }));
    expect(readEngineHealth(NOW)).toEqual({});
  });

  it("treats an until it cannot parse as spent rather than as a permanent block", () => {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ codex: { state: "exhausted", until: "whenever" } }));

    expect(isEngineExhausted(readEngineHealth(NOW), "codex")).toBe(false);
  });
});

describe("recordExhaustedWindows", () => {
  const spent = (name: string, minutesOut: number) => ({ name, usedPercent: 100, resetsAt: secondsAt(minutesOut) });

  it("records the last of several spent windows to reopen", () => {
    recordExhaustedWindows("codex", [spent("5h", 60), spent("7d", 240)], NOW);

    expect(readEngineHealth(NOW).codex).toMatchObject({ state: "exhausted", until: at(240).toISOString() });
  });

  it("ignores a window with allowance left, or one that has already reopened", () => {
    recordExhaustedWindows("codex", [{ name: "5h", usedPercent: 99, resetsAt: secondsAt(60) }], NOW);
    recordExhaustedWindows("claude", [spent("5h", -60)], NOW);

    expect(readEngineHealth(NOW)).toEqual({});
  });
});

describe("resolveHealthyFallbackEngine", () => {
  const config = {
    engines: { codex: { fallback: ["claude", "grok"] }, claude: {}, grok: {} },
  } as unknown as JinnConfig;
  const installed = () => true;
  const exhausted = (...engines: string[]) =>
    Object.fromEntries(engines.map((engine) => [engine, { state: "exhausted" as const, until: at(60).toISOString() }]));

  it("skips a member whose window has not reopened and takes the next one", () => {
    expect(resolveHealthyFallbackEngine(config, "codex", installed, exhausted("claude"))).toBe("grok");
  });

  it("takes the first member back once its window has passed", () => {
    expect(resolveHealthyFallbackEngine(config, "codex", installed, readEngineHealth(NOW))).toBe("claude");
  });

  it("still answers when every member is exhausted, so health cannot empty a chain", () => {
    expect(resolveHealthyFallbackEngine(config, "codex", installed, exhausted("claude", "grok"))).toBe("claude");
  });

  it("never returns a member the caller rejects, exhausted chain or not", () => {
    const onlyGrok = (engine: string) => engine === "grok";
    expect(resolveHealthyFallbackEngine(config, "codex", onlyGrok, exhausted("claude", "grok"))).toBe("grok");
  });
});

describe("preferHealthySessionEngine", () => {
  const config = {
    engines: { codex: { fallback: ["claude", "grok"] }, claude: {}, grok: {} },
  } as unknown as JinnConfig;
  const installed = () => true;
  const exhausted = (...engines: string[]) =>
    Object.fromEntries(engines.map((engine) => [engine, { state: "exhausted" as const, until: at(60).toISOString() }]));

  it("leaves a preference alone while its allowance holds", () => {
    expect(preferHealthySessionEngine(config, "codex", installed, {})).toBe("codex");
  });

  it("does not move off a preference that is merely degraded", () => {
    const degraded = { codex: { state: "degraded" as const, until: at(10).toISOString() } };
    expect(preferHealthySessionEngine(config, "codex", installed, degraded)).toBe("codex");
  });

  it("hands a spent preference to the first member of its chain that can serve", () => {
    expect(preferHealthySessionEngine(config, "codex", installed, exhausted("codex"))).toBe("claude");
    expect(preferHealthySessionEngine(config, "codex", installed, exhausted("codex", "claude"))).toBe("grok");
  });

  it("returns the preference unchanged when nothing in the chain is healthy", () => {
    expect(preferHealthySessionEngine(config, "codex", installed, exhausted("codex", "claude", "grok"))).toBe("codex");
  });

  it("returns the preference unchanged when the only healthy member is not installed", () => {
    const onlyCodexInstalled = (engine: string) => engine === "codex";
    expect(preferHealthySessionEngine(config, "codex", onlyCodexInstalled, exhausted("codex"))).toBe("codex");
  });
});
