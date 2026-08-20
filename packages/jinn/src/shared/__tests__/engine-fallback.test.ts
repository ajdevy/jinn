import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { applyLegacyFallbackMigration, resolveFallbackEngine } from "../engine-fallback.js";
import { ENGINE_NAMES, type EngineName } from "../models.js";
import type { JinnConfig } from "../types.js";

/** A loaded config, as `loadConfig` hands it to the migration. */
function configWith(
  sessions: JinnConfig["sessions"],
  claude: Partial<JinnConfig["engines"]["claude"]> = {},
): JinnConfig {
  return {
    gateway: { port: 7779, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus", ...claude },
      codex: { bin: "codex", model: "gpt-5.5" },
    },
    sessions,
  } as JinnConfig;
}

describe("applyLegacyFallbackMigration", () => {
  it("maps the deprecated sessions pair onto engines.claude.fallback", () => {
    const config = configWith({ rateLimitStrategy: "fallback", fallbackEngine: "codex" });

    applyLegacyFallbackMigration(config, () => {});

    expect(config.engines.claude.fallback).toEqual(["codex"]);
    // Removing the legacy keys is a later Todo: anything still reading them must behave as before.
    expect(config.sessions?.rateLimitStrategy).toBe("fallback");
    expect(config.sessions?.fallbackEngine).toBe("codex");
  });

  it("falls back to codex when only the strategy is set", () => {
    const config = configWith({ rateLimitStrategy: "fallback" });
    applyLegacyFallbackMigration(config, () => {});
    expect(config.engines.claude.fallback).toEqual(["codex"]);
  });

  it("synthesizes no chain when the strategy is absent or \"wait\"", () => {
    for (const sessions of [undefined, { rateLimitStrategy: "wait" } as const]) {
      const config = configWith(sessions);
      applyLegacyFallbackMigration(config, () => {});
      for (const name of ENGINE_NAMES) {
        expect(config.engines[name]?.fallback).toBeUndefined();
      }
    }
  });

  it("leaves an explicit chain alone, including an explicit empty one", () => {
    const chosen = configWith({ rateLimitStrategy: "fallback", fallbackEngine: "codex" }, { fallback: ["grok"] });
    applyLegacyFallbackMigration(chosen, () => {});
    expect(chosen.engines.claude.fallback).toEqual(["grok"]);

    const optedOut = configWith({ rateLimitStrategy: "fallback", fallbackEngine: "codex" }, { fallback: [] });
    applyLegacyFallbackMigration(optedOut, () => {});
    expect(optedOut.engines.claude.fallback).toEqual([]);
  });

  it("warns once per mapped engine, and not at all when the mapping does not fire", async () => {
    vi.resetModules();
    const { applyLegacyFallbackMigration: migrate } = await import("../engine-fallback.js");
    const warn = vi.fn();

    migrate(configWith({ rateLimitStrategy: "fallback", fallbackEngine: "codex" }), warn);
    migrate(configWith({ rateLimitStrategy: "fallback", fallbackEngine: "codex" }), warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("engines.claude.fallback");

    migrate(configWith({ rateLimitStrategy: "wait" }), warn);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("engines.<name>.fallback round-trip", () => {
  // CONFIG_PATH resolves at module load from JINN_HOME, so point it at a temp dir
  // and re-import (same pattern as the saveConfigAtomic tests).
  let tmpHome: string;
  const prevHome = process.env.JINN_HOME;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-engine-fallback-"));
    process.env.JINN_HOME = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.JINN_HOME;
    else process.env.JINN_HOME = prevHome;
    vi.resetModules();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("loads a chain verbatim and survives a save/reload", async () => {
    const { loadConfig, saveConfigAtomic } = await import("../config.js");
    fs.writeFileSync(path.join(tmpHome, "config.yaml"), yaml.dump({
      gateway: { port: 7778, host: "127.0.0.1" },
      engines: {
        default: "claude",
        claude: { bin: "claude", model: "opus", fallback: ["codex", "grok"] },
        codex: { bin: "codex", model: "gpt-5.5" },
      },
    }));

    const loaded = loadConfig();
    expect(loaded.engines.claude.fallback).toEqual(["codex", "grok"]);

    saveConfigAtomic(loaded);
    expect(loadConfig().engines.claude.fallback).toEqual(["codex", "grok"]);
  });
});

describe("resolveFallbackEngine", () => {
  /** A config carrying nothing but the chains under test. */
  function chains(map: Partial<Record<EngineName, EngineName[]>>): JinnConfig {
    const engines = Object.fromEntries(
      Object.entries(map).map(([name, fallback]) => [name, { bin: name, model: "m", fallback }]),
    );
    return { engines } as unknown as JinnConfig;
  }

  const usable = () => true;

  it("returns the first usable engine in the chain", () => {
    expect(resolveFallbackEngine(chains({ claude: ["codex", "grok"] }), "claude", usable)).toBe("codex");
  });

  it("skips members the caller cannot use", () => {
    const config = chains({ claude: ["codex", "grok"] });
    expect(resolveFallbackEngine(config, "claude", (engine) => engine === "grok")).toBe("grok");
  });

  it("walks a skipped engine's own chain", () => {
    const config = chains({ claude: ["codex"], codex: ["grok"] });
    expect(resolveFallbackEngine(config, "claude", (engine) => engine === "grok")).toBe("grok");
  });

  it("terminates on a cycle, and never offers the engine it started from", () => {
    const config = chains({ claude: ["codex"], codex: ["claude"] });
    const asked: string[] = [];

    const resolved = resolveFallbackEngine(config, "claude", (engine) => {
      asked.push(engine);
      return false;
    });

    expect(resolved).toBeNull();
    expect(asked).toEqual(["codex"]);
  });

  it("resolves nothing for an absent or an empty chain", () => {
    expect(resolveFallbackEngine(chains({}), "claude", usable)).toBeNull();
    expect(resolveFallbackEngine(chains({ claude: [] }), "claude", usable)).toBeNull();
  });
});
