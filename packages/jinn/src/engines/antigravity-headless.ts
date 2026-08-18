import { spawn, type ChildProcess } from "node:child_process";
import type { EngineRunOpts, EngineResult, InterruptibleEngine, StreamDelta } from "../shared/types.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { buildEngineChildEnv } from "../shared/child-env.js";
import {
  antigravityJinnSessionEnv,
  cleanupAntigravityJinnMcpConfig,
  ensureAntigravityJinnMcpConfig,
} from "./antigravity-mcp.js";

const ANTIGRAVITY_TURN_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export interface AntigravityParsedLine {
  conversationId?: string;
  deltas: StreamDelta[];
  terminal: boolean;
  result?: string;
  error?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function buildAntigravityHeadlessArgs(opts: EngineRunOpts, prompt: string): string[] {
  const args: string[] = [];
  if (opts.resumeSessionId) args.push("--conversation", opts.resumeSessionId);
  if (opts.model) args.push("--model", opts.model);
  args.push("--dangerously-skip-permissions");
  args.push(...(opts.cliFlags ?? []).filter((flag) => flag !== "--chrome"));
  args.push("--output-format", "stream-json", "-p", prompt);
  return args;
}

export function parseAntigravityStreamLine(line: string): AntigravityParsedLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const event = asRecord(parsed);
  if (!event) return null;
  if (event.event === "init") {
    return {
      conversationId: nonEmptyString(event.conversation_id),
      deltas: [],
      terminal: false,
    };
  }
  if (event.event === "step_update") {
    const update = asRecord(event.step_update);
    if (!update || update.step_type !== "tool") return null;
    const toolName = nonEmptyString(update.tool_name) ?? "tool";
    const toolId = typeof update.step_index === "number" ? String(update.step_index) : undefined;
    if (update.state === "ACTIVE") {
      return {
        conversationId: nonEmptyString(update.conversation_id),
        deltas: [{ type: "tool_use", content: `Using ${toolName}`, toolName, toolId }],
        terminal: false,
      };
    }
    if (update.state === "DONE") {
      const info = asRecord(update.tool_info);
      const failed = asRecord(info?.error) !== null;
      return {
        conversationId: nonEmptyString(update.conversation_id),
        deltas: [{
          type: "tool_result",
          content: `${toolName} ${failed ? "failed" : "done"}`,
          toolName,
          toolId,
        }],
        terminal: false,
      };
    }
    return null;
  }
  if (event.event !== "result") return null;
  const result = asRecord(event.result);
  if (!result) return null;
  if (result.status === "SUCCESS") {
    return {
      conversationId: nonEmptyString(result.conversation_id),
      deltas: [],
      terminal: true,
      result: typeof result.response === "string" ? result.response : "",
    };
  }
  if (result.status !== "ERROR") return null;
  return {
    conversationId: nonEmptyString(result.conversation_id),
    deltas: [],
    terminal: true,
    error: nonEmptyString(result.error) ?? "Antigravity turn failed",
  };
}

interface LiveProcess {
  proc: ChildProcess;
  terminationReason: string | null;
}

export class AntigravityHeadlessEngine implements InterruptibleEngine {
  name = "antigravity" as const;
  private liveProcesses = new Map<string, LiveProcess>();

  kill(sessionId: string, reason = "Interrupted"): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;
    live.terminationReason = reason.startsWith("Interrupted") ? reason : `Interrupted: ${reason}`;
    this.terminateProcessGroup(live.proc);
  }

  killAll(): void {
    for (const sessionId of this.liveProcesses.keys()) {
      this.kill(sessionId, "Interrupted: gateway shutting down");
    }
  }

  killIdle(): void {
    /* Batch engine processes exist only while a turn is active. */
  }

  isAlive(sessionId: string): boolean {
    const live = this.liveProcesses.get(sessionId);
    return !!live && !live.proc.killed && live.proc.exitCode === null;
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const trackingId = opts.sessionId ?? `antigravity-${Date.now()}`;
    let prompt = opts.prompt;
    if (opts.systemPrompt && !opts.resumeSessionId) prompt = `${opts.systemPrompt}\n\n---\n\n${prompt}`;
    if (opts.attachments?.length) {
      prompt += "\n\nAttached files:\n" + opts.attachments.map((attachment) => `- ${attachment}`).join("\n");
    }

    const mcpConfig = ensureAntigravityJinnMcpConfig(opts.resolvedMcp);
    let proc: ChildProcess;
    try {
      proc = spawn(resolveBin("agy", opts.bin), buildAntigravityHeadlessArgs(opts, prompt), {
        cwd: opts.cwd,
        env: {
          ...buildEngineChildEnv(process.env),
          ...antigravityJinnSessionEnv(opts.resolvedMcp),
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      cleanupAntigravityJinnMcpConfig(mcpConfig);
      throw error;
    }
    this.liveProcesses.set(trackingId, { proc, terminationReason: null });

    return new Promise((resolve, reject) => {
      let settled = false;
      let lineBuffer = "";
      let stderr = "";
      let conversationId = opts.resumeSessionId ?? "";
      let hardTimeout: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (hardTimeout) clearTimeout(hardTimeout);
        cleanupAntigravityJinnMcpConfig(mcpConfig);
        this.liveProcesses.delete(trackingId);
      };
      const settle = (result: EngineResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        try { proc.unref?.(); } catch { /* already gone */ }
        resolve(result);
      };
      const handleLine = (line: string) => {
        const parsed = parseAntigravityStreamLine(line);
        if (!parsed) return;
        if (parsed.conversationId) conversationId = parsed.conversationId;
        for (const delta of parsed.deltas) opts.onStream?.(delta);
        if (!parsed.terminal) return;
        this.terminateProcessGroup(proc);
        settle({
          sessionId: conversationId,
          result: parsed.result ?? "",
          ...(parsed.error ? { error: parsed.error } : { numTurns: 1 }),
        });
      };
      const finalizeNonTerminal = (code: number | null) => {
        if (settled) return;
        handleLine(lineBuffer);
        if (settled) return;
        const terminationReason = this.liveProcesses.get(trackingId)?.terminationReason;
        if (terminationReason) {
          settle({ sessionId: conversationId, result: "", error: terminationReason });
          return;
        }
        const detail = stderr.trim().slice(0, 500);
        settle({
          sessionId: conversationId,
          result: "",
          error: `Antigravity exited with code ${code}${detail ? `: ${detail}` : " without a terminal result"}`,
        });
      };

      proc.stdout!.on("data", (chunk: Buffer) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      });
      proc.stderr!.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-10 * 1024);
      });
      proc.on("close", (code) => finalizeNonTerminal(code));
      proc.on("exit", (code) => {
        if (settled) return;
        const timer = setTimeout(() => finalizeNonTerminal(code), 1500);
        timer.unref?.();
      });
      proc.on("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Failed to spawn Antigravity CLI: ${error.message}`));
      });
      hardTimeout = setTimeout(() => {
        const live = this.liveProcesses.get(trackingId);
        if (!live || settled) return;
        live.terminationReason = "Antigravity turn timed out";
        this.terminateProcessGroup(proc);
      }, ANTIGRAVITY_TURN_TIMEOUT_MS);
      hardTimeout.unref?.();
    });
  }

  private signalProcess(proc: ChildProcess, signal: NodeJS.Signals): void {
    if (proc.exitCode !== null) return;
    try {
      if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, signal);
      else proc.kill(signal);
    } catch {
      /* Process already exited. */
    }
  }

  private terminateProcessGroup(proc: ChildProcess): void {
    this.signalProcess(proc, "SIGTERM");
    const timer = setTimeout(() => {
      if (proc.exitCode === null) this.signalProcess(proc, "SIGKILL");
    }, 2000);
    timer.unref?.();
  }
}
