import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { EngineResult, McpGlobalConfig, McpServerStdioConfig, ResolvedMcpConfig } from "../../shared/types.js";
import { makeFakeProc, flush, agentEnd, type SpawnCall } from "./support/pi-spawn-harness.js";

const spawnCalls: SpawnCall[] = [];

vi.mock("node:child_process", () => ({
  spawn: vi.fn((bin: string, args: string[], opts: unknown) => {
    const proc = makeFakeProc();
    spawnCalls.push({ bin, args, opts, proc });
    return proc;
  }),
}));

import { PiEngine } from "../pi.js";
import { logger } from "../../shared/logger.js";
import { JINN_HOME } from "../../shared/paths.js";
import { resolveMcpServers } from "../../mcp/resolver.js";
import { setJinnAttachGate } from "../../mcp/attachment.js";
import { attachSessionIdentity } from "../../mcp/identity.js";

async function startRun(): Promise<{ engine: PiEngine; promise: Promise<EngineResult>; call: SpawnCall }> {
  const engine = new PiEngine();
  const promise = engine.run({
    prompt: "hello",
    cwd: "/tmp",
    sessionId: "jinn-pi-1",
    model: "ollama/gemma4:12b",
  });
  await flush();
  const call = spawnCalls[spawnCalls.length - 1]!;
  expect(call).toBeDefined();
  return { engine, promise, call };
}

async function startStreamingRun(onStream: (delta: import("../../shared/types.js").StreamDelta) => void) {
  const engine = new PiEngine();
  const promise = engine.run({
    prompt: "hello",
    cwd: "/tmp",
    sessionId: "jinn-pi-stream",
    model: "ollama/gemma4:12b",
    onStream,
  });
  await flush();
  return { promise, call: spawnCalls[spawnCalls.length - 1]! };
}

beforeEach(() => {
  spawnCalls.length = 0;
});

describe("PiEngine lifecycle", () => {

  it("correlates a successful MCP receipt with the native Pi tool id", async () => {
    const deltas: import("../../shared/types.js").StreamDelta[] = [];
    const { promise, call } = await startStreamingRun((delta) => deltas.push(delta));
    call.proc.emitStdout(JSON.stringify({
      type: "tool_execution_end",
      toolName: "update_work_item",
      toolCallId: "call-1",
      result: { content: [{ type: "text", text: '{"activityReceiptId":"todo:wi_release"}' }] },
    }) + "\n");
    call.proc.emitStdout(agentEnd("done") + "\n");
    await flush();
    call.proc.close(0);
    await promise;

    expect(deltas).toContainEqual({
      type: "tool_result",
      content: '{"activityReceiptId":"todo:wi_release"}',
      toolName: "update_work_item",
      toolId: "call-1",
      activityReceiptId: "todo:wi_release",
    });
  });

  it("records agent_end output but resolves only after the process closes", async () => {
    const { promise, call } = await startRun();
    let settled = false;
    void promise.then(() => { settled = true; });

    call.proc.emitStdout(agentEnd("final answer") + "\n");
    await flush();
    expect(settled).toBe(false);

    call.proc.close(0);
    const result = await promise;
    expect(result).toMatchObject({ sessionId: "jinn-pi-1", result: "final answer" });
    expect(result.error).toBeUndefined();
  });

  it("treats exit 0 with no final assistant response as an error", async () => {
    const { promise, call } = await startRun();
    call.proc.close(0);

    const result = await promise;
    expect(result.result).toBe("");
    expect(result.error).toMatch(/without a final assistant response/);
  });

  it("does not return partial text as the result when interrupted", async () => {
    const { engine, promise, call } = await startRun();
    call.proc.emitStdout(agentEnd("partial") + "\n");
    await flush();

    engine.kill("jinn-pi-1", "Interrupted: user stopped");
    call.proc.close(null);
    const result = await promise;
    expect(result.result).toBe("");
    expect(result.error).toBe("Interrupted: user stopped");
  });
});

/**
 * Pi's parser reads any dash-leading argv token as an option — `pi "- "` exits with
 * `Error: Unknown option: -` — and it has no `--` separator (it reports `--` itself
 * as an unknown option). Its documented escape hatch is stdin, which pi consumes as
 * the message when no positional prompt is present.
 */
describe("PiEngine — prompt delivery over stdin", () => {
  async function runWithPrompt(prompt: string) {
    const engine = new PiEngine();
    const promise = engine.run({ prompt, cwd: "/tmp", sessionId: "jinn-pi-dash", model: "ollama/gemma4:12b" });
    await flush();
    const call = spawnCalls[spawnCalls.length - 1]!;
    return { promise, call };
  }

  it.each(["- ", "-p do the thing", "--json output please", "-"])(
    "keeps the dash-leading prompt %j off argv and writes it to stdin",
    async (prompt) => {
      const { promise, call } = await runWithPrompt(prompt);
      expect(call.args).not.toContain(prompt);
      expect(call.proc.stdinWrites.join("")).toBe(prompt);
      expect(call.proc.stdinEnded).toBe(true);
      call.proc.emitStdout(agentEnd("ok") + "\n");
      await flush();
      call.proc.close(0);
      await promise;
    },
  );

  it("still delivers an ordinary prompt, and never as a trailing positional", async () => {
    const { promise, call } = await runWithPrompt("hello there");
    expect(call.args).not.toContain("hello there");
    expect(call.proc.stdinWrites.join("")).toBe("hello there");
    call.proc.emitStdout(agentEnd("ok") + "\n");
    await flush();
    call.proc.close(0);
    await promise;
  });
});

/**
 * The jinn belt reaches pi as a per-session `--extension` module while the session's
 * identity and the gateway credentials ride pi's child env. Neither end was pinned
 * from `run()`: PLA-161 found pi employees starting with no company tools at all,
 * nobody being told, and the whole suite green.
 */
describe("PiEngine — jinn MCP attachment", () => {
  const GATEWAY_URL = "http://127.0.0.1:56789";
  const TOKEN = "pi-attach-test-token";
  const SID = "jinn-pi-mcp";
  const MCP_ON = { browser: { enabled: false }, gateway: { enabled: true } } as McpGlobalConfig;

  let envBackup: Record<string, string | undefined>;
  beforeEach(() => {
    envBackup = { JINN_GATEWAY_URL: process.env.JINN_GATEWAY_URL, JINN_GATEWAY_TOKEN: process.env.JINN_GATEWAY_TOKEN };
    process.env.JINN_GATEWAY_URL = GATEWAY_URL;
    process.env.JINN_GATEWAY_TOKEN = TOKEN;
    // The resolver only attaches the belt behind an armed-ok smoke gate (unarmed
    // fails closed); a booted gateway arms it, so this suite does.
    setJinnAttachGate({ ok: true });
  });
  afterEach(() => {
    setJinnAttachGate(null);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });

  /** The real resolver payload a pi session gets when the belt is on. */
  const attachedMcp = () => attachSessionIdentity(resolveMcpServers(MCP_ON, undefined, "pi"), SID);

  async function runWithMcp(resolvedMcp: ResolvedMcpConfig | undefined) {
    const engine = new PiEngine();
    const promise = engine.run({ prompt: "hello", cwd: "/tmp", sessionId: SID, model: "forge/qwen3.8-27b", resolvedMcp });
    await flush();
    const call = spawnCalls[spawnCalls.length - 1]!;
    return {
      call,
      // Settling the run deletes the extension dir, so assert before finishing.
      finish: async () => {
        call.proc.emitStdout(agentEnd("ok") + "\n");
        await flush();
        call.proc.close(0);
        await promise;
      },
    };
  }

  it("passes the generated extension file to pi as --extension", async () => {
    const { call, finish } = await runWithMcp(attachedMcp());

    const flagIndex = call.args.indexOf("--extension");
    expect(flagIndex).toBeGreaterThan(-1);
    const extensionPath = call.args[flagIndex + 1]!;
    expect(fs.existsSync(extensionPath)).toBe(true);
    expect(fs.readFileSync(extensionPath, "utf-8")).toContain("registerTool");

    await finish();
  });

  it("attaches nothing when the resolved set carries no jinn server", async () => {
    const extensionDir = path.join(JINN_HOME, "tmp", "pi-mcp", SID);
    fs.rmSync(extensionDir, { recursive: true, force: true });

    const { call, finish } = await runWithMcp({ mcpServers: {} });

    expect(call.args).not.toContain("--extension");
    expect(fs.existsSync(extensionDir)).toBe(false);

    await finish();
  });

  it("warns when the belt was resolved but pi cannot wire it, and stays quiet when it attaches", async () => {
    const warnings: string[] = [];
    vi.spyOn(logger, "warn").mockImplementation((message: string) => { warnings.push(message); });

    const unwirable = await runWithMcp({ mcpServers: { jinn: { type: "sse", url: "https://mcp.example/jinn" } } });
    expect(unwirable.call.args).not.toContain("--extension");
    const warning = warnings.find((message) => message.includes("jinn toolset"));
    expect(warning).toBeDefined();
    expect(warning).toContain("Pi engine");
    expect(warning).toContain(SID);
    expect(warning).toContain("URL-based");
    await unwirable.finish();

    warnings.length = 0;
    const attached = await runWithMcp(attachedMcp());
    expect(attached.call.args).toContain("--extension");
    expect(warnings.filter((message) => message.includes("jinn toolset"))).toEqual([]);
    await attached.finish();
  });

  it("hands pi the gateway credentials and session capability the extension reads at tool-call time", async () => {
    const resolved = attachedMcp();
    const { call, finish } = await runWithMcp(resolved);

    // The extension reads all four straight from process.env, with no gateway.json
    // fallback of its own — scrub any of them and every pi tool call 401s silently.
    const env = (call.opts as { env: Record<string, string> }).env;
    expect(env.JINN_GATEWAY_TOKEN).toBe(TOKEN);
    expect(env.JINN_GATEWAY_URL).toBe(GATEWAY_URL);
    expect(env.JINN_SESSION_ID).toBe(SID);
    expect(env.JINN_SESSION_CAPABILITY).toBe((resolved.mcpServers.jinn as McpServerStdioConfig).env?.JINN_SESSION_CAPABILITY);

    await finish();
  });
});
