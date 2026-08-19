import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Branch A of handleRateLimit walks the limited engine's own `fallback` chain, so
 * the roll is codex → claude here rather than the claude → codex the guard suite
 * covers. What the substitute is handed — its own bin, its own model, its own MCP
 * payload — is the half that used to be hardcoded to one pair of engines.
 */

// ── Mocks (must be declared before importing the module under test) ──────────

const engineAvailableMock = vi.fn<(...args: unknown[]) => boolean>();
vi.mock("../../shared/models.js", () => ({
  engineAvailable: (...args: unknown[]) => engineAvailableMock(...args),
  effortLevelsForModel: vi.fn(() => ["low", "medium", "high"]),
  // The chain walker's module reads both of these at load time.
  ENGINE_NAMES: ["claude", "codex", "antigravity", "grok", "pi", "hermes"],
  isKnownEngine: (name: string) => ["claude", "codex", "antigravity", "grok", "pi", "hermes"].includes(name),
}));

const resolveEngineRunMcpMock = vi.fn<(...args: unknown[]) => Record<string, unknown>>(() => ({}));
vi.mock("../engine-run-mcp.js", () => ({
  resolveEngineRunMcp: (...args: unknown[]) => resolveEngineRunMcpMock(...args),
}));

const updateSessionForAttemptMock = vi.fn(
  (_id: string, _token: string, updates: Partial<Session>) => makeSession({ ...updates }),
);
vi.mock("../registry.js", () => ({
  getSession: () => makeSession(codexSessionFields()),
  getMessages: vi.fn(() => []),
  updateSessionForAttempt: (...a: Parameters<typeof updateSessionForAttemptMock>) => updateSessionForAttemptMock(...a),
  getEngineSessionRef: (session: Session, engine: string) => session.engineSessions?.[engine] ?? {},
  nextEngineSessionFields: (session: Session, engine: string, id: string) => ({
    engineSessions: { ...(session.engineSessions ?? {}), [engine]: { id } },
    ...(session.engine === engine ? { engineSessionId: id } : {}),
  }),
}));

vi.mock("../../shared/usageAwareness.js", () => ({ recordClaudeRateLimit: vi.fn() }));
vi.mock("../../shared/effort.js", () => ({ resolveEffort: vi.fn(() => "medium") }));
vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Branch B's deadline is already past, so a case that reaches it returns "timeout"
// without sleeping or calling the engine — which is how "no substitute" reads here.
vi.mock("../../shared/rateLimit.js", () => ({
  computeNextRetryDelayMs: vi.fn(() => ({ delayMs: 0, resumeAt: undefined })),
  computeRateLimitDeadlineMs: vi.fn(() => Date.now() - 1),
  detectRateLimit: vi.fn(() => ({ limited: false })),
  rateLimitEngineLabel: (engine: string) => engine[0]!.toUpperCase() + engine.slice(1),
}));

import { makeSession } from "./helpers/session-fixture.js";
import { handleRateLimit, type RateLimitHandlerOpts } from "../rate-limit-handler.js";
import { computeNextRetryDelayMs } from "../../shared/rateLimit.js";
import type { EngineResult, JinnConfig, Session } from "../../shared/types.js";

const RESETS_AT = new Date("2026-01-01T00:00:00.000Z");

function codexSessionFields(): Partial<Session> {
  return { engine: "codex", engineSessionId: "codex-thread-1", model: "gpt-5.6-sol" };
}

/** A codex-primary session whose engine names claude as its fallback. */
function makeOpts(
  claudeRun: ReturnType<typeof vi.fn>,
  configOverrides: Partial<JinnConfig["engines"]> = {},
): RateLimitHandlerOpts {
  return {
    session: makeSession(codexSessionFields()),
    attemptToken: "attempt-1",
    prompt: "hello",
    engineConfig: { bin: "codex", model: "gpt-5.6-sol" },
    config: {
      engines: {
        codex: { bin: "codex", model: "gpt-5.6-sol", fallback: ["claude"] },
        claude: { bin: "claude", model: "opus" },
        ...configOverrides,
      },
    } as unknown as RateLimitHandlerOpts["config"],
    engines: new Map([["claude", { run: claudeRun } as unknown as RateLimitHandlerOpts["engine"]]]),
    engine: { run: vi.fn() } as unknown as RateLimitHandlerOpts["engine"],
    rateLimit: { resetsAt: undefined },
    originalResult: { result: "", sessionId: "codex-thread-1" } as EngineResult,
    hooks: {},
  };
}

function overrideRecord(): Record<string, unknown> | undefined {
  const flip = updateSessionForAttemptMock.mock.calls.find(([, , updates]) => updates.transportMeta);
  const meta = flip?.[2].transportMeta as Record<string, unknown> | undefined;
  return meta?.engineOverride as Record<string, unknown> | undefined;
}

describe("handleRateLimit — chain fallback for any engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    engineAvailableMock.mockReturnValue(true);
    vi.mocked(computeNextRetryDelayMs).mockReturnValue({ delayMs: 0, resumeAt: undefined });
    resolveEngineRunMcpMock.mockReturnValue({});
  });

  it("runs the turn on the engine its chain names, parking the limited engine's thread", async () => {
    const claudeRun = vi.fn(async () => ({ result: "from-claude", sessionId: "claude-1" }) as EngineResult);

    const outcome = await handleRateLimit(makeOpts(claudeRun));

    expect(claudeRun).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("fallback");
    expect(updateSessionForAttemptMock).toHaveBeenCalledWith("sess-1", "attempt-1", expect.objectContaining({
      engine: "claude",
      engineSessionId: null,
      engineSessions: { codex: { id: "codex-thread-1" } },
    }));
    // The substitute's own thread id lands in its typed ref once the turn returns.
    expect(updateSessionForAttemptMock).toHaveBeenCalledWith("sess-1", "attempt-1", expect.objectContaining({
      engineSessions: expect.objectContaining({ claude: { id: "claude-1" } }),
    }));
  });

  it("records the limited engine and its thread id on the override, expiring at the reset", async () => {
    vi.mocked(computeNextRetryDelayMs).mockReturnValue({ delayMs: 0, resumeAt: RESETS_AT });

    await handleRateLimit(makeOpts(vi.fn(async () => ({ result: "ok" }) as EngineResult)));

    expect(overrideRecord()).toEqual({
      originalEngine: "codex",
      originalEngineSessionId: "codex-thread-1",
      until: RESETS_AT.toISOString(),
      syncSince: expect.any(String),
    });
  });

  it("holds the override for six hours when the limit names no reset", async () => {
    await handleRateLimit(makeOpts(vi.fn(async () => ({ result: "ok" }) as EngineResult)));

    const until = new Date(String(overrideRecord()?.until)).getTime();
    expect(until - Date.now()).toBeGreaterThan(6 * 60 * 60_000 - 5_000);
    expect(until - Date.now()).toBeLessThanOrEqual(6 * 60 * 60_000);
  });

  it("names both real engines in lastError", async () => {
    vi.mocked(computeNextRetryDelayMs).mockReturnValue({ delayMs: 0, resumeAt: RESETS_AT });

    await handleRateLimit(makeOpts(vi.fn(async () => ({ result: "ok" }) as EngineResult)));

    expect(updateSessionForAttemptMock).toHaveBeenCalledWith("sess-1", "attempt-1", expect.objectContaining({
      lastError: "Codex usage limit — using Claude until 2026-01-01T00:00:00.000Z",
    }));
  });

  it("runs the substitute on its own bin and model, never the limited session's", async () => {
    const claudeRun = vi.fn(async () => ({ result: "ok" }) as EngineResult);

    await handleRateLimit(makeOpts(claudeRun));

    expect(claudeRun).toHaveBeenCalledWith(expect.objectContaining({ bin: "claude", model: "opus" }));
  });

  it("hands the substitute the MCP payload resolved for the substitute", async () => {
    const resolved = { mcpServers: { jinn: { command: "jinn" } } };
    resolveEngineRunMcpMock.mockReturnValue({ resolvedMcp: resolved, mcpConfigPath: "/tmp/claude-mcp.json" });
    const claudeRun = vi.fn(async () => ({ result: "ok" }) as EngineResult);

    await handleRateLimit(makeOpts(claudeRun));

    expect(resolveEngineRunMcpMock).toHaveBeenCalledWith(expect.objectContaining({ engine: "claude", sessionId: "sess-1" }));
    expect(claudeRun).toHaveBeenCalledWith(expect.objectContaining({
      resolvedMcp: resolved,
      mcpConfigPath: "/tmp/claude-mcp.json",
    }));
  });

  it("gives a substitute that cannot speak MCP neither field", async () => {
    const claudeRun = vi.fn(async (_opts: Record<string, unknown>) => ({ result: "ok" }) as EngineResult);

    await handleRateLimit(makeOpts(claudeRun));

    const runOpts = claudeRun.mock.calls[0]![0];
    expect(runOpts).not.toHaveProperty("resolvedMcp");
    expect(runOpts).not.toHaveProperty("mcpConfigPath");
  });
});

describe("handleRateLimit — chains with nothing usable in them", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    engineAvailableMock.mockReturnValue(true);
    vi.mocked(computeNextRetryDelayMs).mockReturnValue({ delayMs: 0, resumeAt: undefined });
  });

  it("waits when the limited engine has no chain", async () => {
    const claudeRun = vi.fn();
    const opts = makeOpts(claudeRun, { codex: { bin: "codex", model: "gpt-5.6-sol" } } as never);

    expect((await handleRateLimit(opts)).kind).toBe("timeout");
    expect(claudeRun).not.toHaveBeenCalled();
  });

  it("waits when the chain is explicitly empty", async () => {
    const claudeRun = vi.fn();
    const opts = makeOpts(claudeRun, { codex: { bin: "codex", model: "gpt-5.6-sol", fallback: [] } } as never);

    expect((await handleRateLimit(opts)).kind).toBe("timeout");
    expect(claudeRun).not.toHaveBeenCalled();
  });

  it("waits when the only engine in the chain is not installed", async () => {
    engineAvailableMock.mockReturnValue(false);
    const claudeRun = vi.fn();

    expect((await handleRateLimit(makeOpts(claudeRun))).kind).toBe("timeout");
    expect(claudeRun).not.toHaveBeenCalled();
  });

  it("waits when the only engine in the chain is not registered", async () => {
    const claudeRun = vi.fn();
    const opts = { ...makeOpts(claudeRun), engines: new Map() };

    expect((await handleRateLimit(opts)).kind).toBe("timeout");
    expect(claudeRun).not.toHaveBeenCalled();
  });
});
