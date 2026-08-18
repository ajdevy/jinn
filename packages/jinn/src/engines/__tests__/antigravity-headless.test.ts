import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as headless from "../antigravity-headless.js";

const { parseAntigravityStreamLine } = headless;

interface FakeProc extends EventEmitter {
  stdin: EventEmitter & { end: (text?: string) => void };
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  killed: boolean;
  pid: number;
  signals: NodeJS.Signals[];
  stdinWrites: string[];
  kill: (signal?: NodeJS.Signals) => boolean;
  unref: () => void;
  emitStdout: (text: string) => void;
  emitStderr: (text: string) => void;
  close: (code: number | null) => void;
  exit: (code: number | null) => void;
}

interface SpawnCall {
  bin: string;
  args: string[];
  opts: unknown;
  proc: FakeProc;
}

const spawnCalls = vi.hoisted(() => [] as SpawnCall[]);

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new EventEmitter() as FakeProc["stdin"];
  proc.stdinWrites = [];
  proc.stdin.end = (text = "") => { proc.stdinWrites.push(text); };
  proc.exitCode = null;
  proc.killed = false;
  proc.pid = 63_630;
  proc.signals = [];
  proc.kill = (signal = "SIGTERM") => {
    proc.killed = true;
    proc.signals.push(signal);
    return true;
  };
  proc.unref = () => {};
  proc.emitStdout = (text) => proc.stdout.emit("data", Buffer.from(text));
  proc.emitStderr = (text) => proc.stderr.emit("data", Buffer.from(text));
  proc.close = (code) => {
    proc.exitCode = code;
    proc.emit("close", code);
  };
  proc.exit = (code) => {
    proc.exitCode = code;
    proc.emit("exit", code);
  };
  return proc;
}

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn((bin: string, args: string[], opts: unknown) => {
    const proc = makeFakeProc();
    spawnCalls.push({ bin, args, opts, proc });
    return proc;
  }),
}));

beforeEach(() => {
  spawnCalls.length = 0;
  vi.spyOn(process, "kill").mockImplementation(() => true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("parseAntigravityStreamLine", () => {
  it("captures the conversation id from init without settling", () => {
    expect(parseAntigravityStreamLine(JSON.stringify({
      event: "init",
      conversation_id: "conversation-0",
      init: {
        model: "example-model",
        cwd: "/workspace",
        tools: ["manage_task"],
        permission_mode: "always-proceed",
      },
    }))).toEqual({
      conversationId: "conversation-0",
      deltas: [],
      terminal: false,
    });
  });

  it("treats an explicit upstream ERROR result as terminal", async () => {
    const parsed = parseAntigravityStreamLine(JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conversation-1",
        status: "ERROR",
        response: "",
        error: "There was a network issue connecting to the server.",
        duration_seconds: 2.5,
        num_turns: 1,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          thinking_tokens: 0,
          cache_read_tokens: 0,
          total_tokens: 0,
        },
      },
    }));

    expect(parsed).toEqual({
      conversationId: "conversation-1",
      deltas: [],
      terminal: true,
      error: "There was a network issue connecting to the server.",
    });
  });

  it("treats an explicit upstream SUCCESS result as terminal", () => {
    const parsed = parseAntigravityStreamLine(JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conversation-2",
        status: "SUCCESS",
        response: "finished\n",
        duration_seconds: 9.3,
        num_turns: 1,
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          thinking_tokens: 1,
          cache_read_tokens: 3,
          total_tokens: 12,
        },
      },
    }));

    expect(parsed).toEqual({
      conversationId: "conversation-2",
      deltas: [{ type: "context", content: "10" }],
      terminal: true,
      result: "finished\n",
      contextTokens: 10,
    });
  });

  it("maps managed-task ACTIVE and DONE updates to one tool lifecycle", () => {
    const active = parseAntigravityStreamLine(JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conversation-3",
        step_index: 3,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "manage_task",
        tool_info: {
          name: "manage_task",
          parameters: { Action: "status", TaskId: "conversation-3/task-1" },
        },
      },
    }));
    const done = parseAntigravityStreamLine(JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conversation-3",
        step_index: 3,
        state: "DONE",
        step_type: "tool",
        tool_name: "manage_task",
        duration_seconds: 0.01,
        tool_info: {
          name: "manage_task",
          parameters: { Action: "status" },
          output: "Task completed.",
        },
      },
    }));

    expect(active).toEqual({
      conversationId: "conversation-3",
      deltas: [{
        type: "tool_use",
        content: "Using manage_task",
        toolName: "manage_task",
        toolId: "3",
      }],
      terminal: false,
    });
    expect(done).toEqual({
      conversationId: "conversation-3",
      deltas: [{
        type: "tool_result",
        content: "manage_task done",
        toolName: "manage_task",
        toolId: "3",
      }],
      terminal: false,
    });
  });
});

describe("buildAntigravityHeadlessArgs", () => {
  it("builds print-mode stream-json args and strips unrelated engine flags", () => {
    const build = (headless as unknown as {
      buildAntigravityHeadlessArgs?: (opts: Record<string, unknown>, prompt: string) => string[];
    }).buildAntigravityHeadlessArgs;
    const args = build?.({
      prompt: "ignored",
      cwd: "/workspace",
      model: "example-model",
      resumeSessionId: "conversation-4",
      cliFlags: ["--chrome", "--verbose"],
    }, "continue work") ?? null;

    expect(args).toEqual([
      "--conversation", "conversation-4",
      "--model", "example-model",
      "--dangerously-skip-permissions",
      "--verbose",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "-p",
    ]);
  });
});

describe("AntigravityHeadlessEngine", () => {
  it("settles an explicit upstream error without waiting for process close", async () => {
    const engine = new headless.AntigravityHeadlessEngine();
    const resultPromise = engine.run({ prompt: "continue", cwd: "/workspace", sessionId: "jinn-session-1" });
    const call = spawnCalls[0]!;
    call.proc.emitStdout(`${JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conversation-5",
        status: "ERROR",
        response: "",
        error: "There was a network issue connecting to the server.",
        duration_seconds: 2.5,
        num_turns: 1,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          thinking_tokens: 0,
          cache_read_tokens: 0,
          total_tokens: 0,
        },
      },
    })}\n`);

    await expect(resultPromise).resolves.toEqual({
      sessionId: "conversation-5",
      result: "",
      error: "There was a network issue connecting to the server.",
    });
    expect(engine.isAlive("jinn-session-1")).toBe(false);
  });

  it("keeps managed-task tool updates pending until the terminal result", async () => {
    const deltas: unknown[] = [];
    const engine = new headless.AntigravityHeadlessEngine();
    const resultPromise = engine.run({
      prompt: "run checks",
      cwd: "/workspace",
      sessionId: "jinn-session-2",
      onStream: (delta) => deltas.push(delta),
    });
    const call = spawnCalls[0]!;
    let settled = false;
    void resultPromise.then(() => { settled = true; });

    call.proc.emitStdout([
      JSON.stringify({
        event: "init",
        conversation_id: "conversation-6",
        init: { tools: ["manage_task"] },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conversation-6",
          step_index: 3,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "manage_task",
          tool_info: { name: "manage_task", parameters: { Action: "status" } },
        },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conversation-6",
          step_index: 3,
          state: "DONE",
          step_type: "tool",
          tool_name: "manage_task",
          tool_info: { name: "manage_task", output: "Task completed." },
        },
      }),
      "",
    ].join("\n"));
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(deltas).toEqual([
      { type: "tool_use", content: "Using manage_task", toolName: "manage_task", toolId: "3" },
      { type: "tool_result", content: "manage_task done", toolName: "manage_task", toolId: "3" },
    ]);

    call.proc.emitStdout(`${JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conversation-6",
        status: "SUCCESS",
        response: "All checks passed.",
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 12 },
      },
    })}\n`);

    await expect(resultPromise).resolves.toEqual({
      sessionId: "conversation-6",
      result: "All checks passed.",
      numTurns: 1,
      contextTokens: 10,
    });
  });

  it("settles with a diagnostic when the process closes without a terminal result", async () => {
    const engine = new headless.AntigravityHeadlessEngine();
    const resultPromise = engine.run({
      prompt: "continue",
      cwd: "/workspace",
      sessionId: "jinn-session-3",
      resumeSessionId: "conversation-7",
    });
    const call = spawnCalls[0]!;
    call.proc.emitStderr("upstream transport failed\n");
    call.proc.close(1);

    const raced = await Promise.race([
      resultPromise,
      new Promise<"TIMED_OUT">((resolve) => setTimeout(() => resolve("TIMED_OUT"), 100)),
    ]);
    expect(raced).toEqual({
      sessionId: "conversation-7",
      result: "",
      error: "Antigravity exited with code 1: upstream transport failed",
    });
    expect(engine.isAlive("jinn-session-3")).toBe(false);
  });

  it("reaps descendants and ignores late output when the leader exits with an inherited pipe", async () => {
    vi.useFakeTimers();
    const processKill = vi.mocked(process.kill);
    const deltas: unknown[] = [];
    const engine = new headless.AntigravityHeadlessEngine();
    const resultPromise = engine.run({
      prompt: "continue",
      cwd: "/workspace",
      sessionId: "jinn-session-4",
      resumeSessionId: "conversation-8",
      onStream: (delta) => deltas.push(delta),
    });
    const call = spawnCalls[0]!;
    call.proc.emitStderr("process exited unexpectedly\n");
    call.proc.exit(1);

    let settled = false;
    void resultPromise.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1_499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(resultPromise).resolves.toEqual({
      sessionId: "conversation-8",
      result: "",
      error: "Antigravity exited with code 1: process exited unexpectedly",
    });
    expect(processKill).toHaveBeenCalledWith(-63_630, "SIGTERM");

    call.proc.emitStdout(`${JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conversation-8",
        step_index: 9,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "manage_task",
      },
    })}\n`);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(processKill).toHaveBeenCalledWith(-63_630, "SIGKILL");
    expect(deltas).toEqual([]);
  });

  it("runs a Windows npm shim through cmd.exe and kills its process tree", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const hostilePrompt = "say \"ok\" & echo %PATH% !value! ^ done";
    const engine = new headless.AntigravityHeadlessEngine();
    const resultPromise = engine.run({
      prompt: hostilePrompt,
      cwd: "C:\\workspace",
      bin: "C:\\tools\\agy.cmd",
      sessionId: "jinn-session-windows",
      resumeSessionId: "conversation-windows",
    });
    const call = spawnCalls[0]!;

    expect(call.bin).toMatch(/[\\/]System32[\\/]cmd\.exe$/);
    expect(call.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(call.args.join(" ")).not.toContain(hostilePrompt);
    expect(call.proc.stdinWrites).toEqual([
      `${JSON.stringify({ type: "user", message: hostilePrompt })}\n`,
    ]);
    engine.kill("jinn-session-windows", "test cleanup");
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]System32[\\/]taskkill\.exe$/),
      ["/pid", "63630", "/t", "/f"],
      expect.objectContaining({ windowsHide: true }),
    );
    call.proc.close(null);
    await expect(resultPromise).resolves.toMatchObject({ error: "Interrupted: test cleanup" });
  });

  it("interrupts only the tracked process group and reports the reason", async () => {
    const processKill = vi.mocked(process.kill);
    const engine = new headless.AntigravityHeadlessEngine();
    const resultPromise = engine.run({
      prompt: "continue",
      cwd: "/workspace",
      sessionId: "jinn-session-5",
      resumeSessionId: "conversation-9",
    });
    const call = spawnCalls[0]!;
    const kill = (engine as unknown as {
      kill?: (sessionId: string, reason?: string) => void;
    }).kill;
    kill?.call(engine, "jinn-session-5", "requested by supervisor");

    expect(processKill).toHaveBeenCalledWith(-63_630, "SIGTERM");
    call.proc.close(null);
    await expect(resultPromise).resolves.toEqual({
      sessionId: "conversation-9",
      result: "",
      error: "Interrupted: requested by supervisor",
    });
  });

  it("terminates and settles a turn at the hard timeout", async () => {
    vi.useFakeTimers();
    const processKill = vi.mocked(process.kill);
    const engine = new headless.AntigravityHeadlessEngine();
    const resultPromise = engine.run({
      prompt: "continue",
      cwd: "/workspace",
      sessionId: "jinn-session-6",
      resumeSessionId: "conversation-10",
    });
    const call = spawnCalls[0]!;

    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(processKill).toHaveBeenCalledWith(-63_630, "SIGTERM");
    call.proc.close(null);

    await expect(resultPromise).resolves.toEqual({
      sessionId: "conversation-10",
      result: "",
      error: "Antigravity turn timed out",
    });
  });

  it("reaps the owned process group after an explicit terminal result", async () => {
    const processKill = vi.mocked(process.kill);
    const engine = new headless.AntigravityHeadlessEngine();
    const resultPromise = engine.run({
      prompt: "run checks",
      cwd: "/workspace",
      sessionId: "jinn-session-7",
    });
    const call = spawnCalls[0]!;
    call.proc.emitStdout(`${JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conversation-11",
        status: "SUCCESS",
        response: "done",
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 },
      },
    })}\n`);

    await expect(resultPromise).resolves.toMatchObject({
      sessionId: "conversation-11",
      result: "done",
    });
    expect(processKill).toHaveBeenCalledWith(-63_630, "SIGTERM");
  });
});
