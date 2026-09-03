import { describe, expect, it } from "vitest";
import type { Engine, EngineResult, JinnConfig } from "../types.js";
import { isProviderFailure, resolveProviderFallback } from "../provider-fallback.js";

const result = (overrides: Partial<EngineResult>): EngineResult => ({ sessionId: "", result: "", ...overrides });

function config(chains: Record<string, string[]>): JinnConfig {
  return {
    gateway: {},
    engines: {
      default: "claude",
      claude: { bin: process.execPath, fallback: chains.claude ?? [] },
      codex: { bin: process.execPath, model: "gpt-5.6-luna", fallback: chains.codex ?? [] },
      grok: { bin: "/definitely-not-installed/grok", fallback: chains.grok ?? [] },
    },
  } as unknown as JinnConfig;
}

function engine(name: string): Engine {
  return { name, async run() { return result({ result: "ok" }); } };
}

describe("provider fallback", () => {
  it("recognizes provider faults only before answer text exists", () => {
    expect(isProviderFailure(result({ error: "Interactive turn failed: server_error" }))).toBe(true);
    expect(isProviderFailure(result({ result: "partial", error: "server_error" }))).toBe(false);
    expect(isProviderFailure(result({ error: "invalid_request" }))).toBe(false);
    expect(isProviderFailure(result({}))).toBe(false);
  });

  it("walks the configured chain, skips unavailable engines, and avoids cycles", () => {
    const engines = new Map([["grok", engine("grok")], ["codex", engine("codex")]]);
    expect(resolveProviderFallback(config({ claude: ["grok", "codex"], grok: ["claude"] }), "claude", engines)).toBe("codex");
    expect(resolveProviderFallback(config({ claude: ["claude"] }), "claude", engines)).toBeUndefined();
  });
});
