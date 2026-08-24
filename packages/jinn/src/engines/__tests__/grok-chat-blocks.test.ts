import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { StreamDelta, EngineResult } from "../../shared/types.js";

/** ICI-1393. Live Grok stdout is only `thought` / `text` / `end`. Tool calls live
 *  in `updates.jsonl`, and the session id first appears on the same `end` line
 *  that settles the turn. A fresh dashboard turn therefore never attached the
 *  transcript, so tool cards never rendered, and the web client never started a
 *  new assistant row — every text run glued into one blob. Tests here assert the
 *  live mid-turn stream (before `end`), not the post-completion result alone. */

interface FakeProc {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: () => void };
  exitCode: number | null;
  killed: boolean;
  kill: () => boolean;
  pid: number;
  on: (event: string, cb: (...a: any[]) => void) => FakeProc;
  _handlers: Record<string, (...a: any[]) => void>;
  emitStdout: (s: string) => void;
}

const spawnCalls: FakeProc[] = [];

function makeFakeProc(): FakeProc {
  const handlers: Record<string, (...a: any[]) => void> = {};
  const p: FakeProc = {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { end: () => {} },
    exitCode: null,
    killed: false,
    pid: 6464,
    kill: () => true,
    _handlers: handlers,
    on(event, cb) { handlers[event] = cb; return p; },
    emitStdout(s) { p.stdout.emit("data", Buffer.from(s)); },
  };
  return p;
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const proc = makeFakeProc();
    spawnCalls.push(proc);
    return proc;
  }),
}));

const osMockState = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  osMockState.home = fsm.mkdtempSync(pathm.join(actual.tmpdir(), "grok-blocks-"));
  const homedir = () => osMockState.home;
  return { ...actual, homedir, default: { ...((actual as any).default ?? actual), homedir } };
});

import { GrokEngine } from "../grok.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await sleep(25);
  }
}

function makeCwd(name: string): { cwd: string; sessionsRoot: string } {
  const cwd = path.join(osMockState.home, name);
  fs.mkdirSync(cwd, { recursive: true });
  const resolved = fs.realpathSync(cwd);
  return {
    cwd,
    sessionsRoot: path.join(osMockState.home, ".grok", "sessions", encodeURIComponent(resolved)),
  };
}

function writeTranscript(sessionsRoot: string, sessionId: string, lines: unknown[]): void {
  const file = path.join(sessionsRoot, sessionId, "updates.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

const toolCall = (sessionId: string, toolCallId: string) => ({
  method: "session/update",
  params: {
    sessionId,
    update: { sessionUpdate: "tool_call", toolCallId, title: "read_file", rawInput: { target_file: "note.txt" } },
  },
});

const toolCallDone = (sessionId: string, toolCallId: string) => ({
  method: "session/update",
  params: {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      title: "read_file",
      content: [{ type: "content", content: { type: "text", text: "hello from the file" } }],
    },
  },
});

const END_LINE = JSON.stringify({ type: "end", stopReason: "EndTurn" }) + "\n";

function startFreshTurn(cwd: string, sessionId: string):
{ deltas: StreamDelta[]; proc: FakeProc; done: Promise<EngineResult> } {
  const deltas: StreamDelta[] = [];
  const engine = new GrokEngine();
  const done = engine.run({
    prompt: "read note.txt and summarise it",
    cwd,
    sessionId,
    model: "grok-build",
    onStream: (delta: StreamDelta) => deltas.push(delta),
  } as any) as Promise<EngineResult>;
  return { deltas, proc: spawnCalls[spawnCalls.length - 1], done };
}

function streamedText(deltas: StreamDelta[]): string {
  return deltas.filter((d) => d.type === "text").map((d) => d.content).join("");
}

beforeEach(() => {
  spawnCalls.length = 0;
});

describe("GrokEngine — live tool cards on a fresh turn", () => {
  it("emits tool deltas mid-turn without ever seeing a session id on stdout", async () => {
    const { cwd, sessionsRoot } = makeCwd("cwd-fresh");
    await flush();
    const turn = startFreshTurn(cwd, "jinn-fresh");
    await flush();
    expect(turn.proc).toBeDefined();

    turn.proc.emitStdout(JSON.stringify({ type: "thought", data: "I should read the file." }) + "\n");
    writeTranscript(sessionsRoot, "fresh-session", [
      toolCall("fresh-session", "tool-1"),
      toolCallDone("fresh-session", "tool-1"),
    ]);

    await waitFor(() => turn.deltas.some((d) => d.type === "tool_result"), "fresh-turn tool result");
    expect(turn.deltas).toContainEqual({
      type: "tool_use",
      content: "Using read_file",
      toolName: "read_file",
      toolId: "tool-1",
      input: "{\"target_file\":\"note.txt\"}",
    });
    expect(turn.deltas).toContainEqual({
      type: "tool_result",
      content: "hello from the file",
      toolName: "read_file",
      toolId: "tool-1",
    });

    turn.proc.emitStdout(JSON.stringify({ type: "text", data: "The file greets us." }) + "\n");
    expect(streamedText(turn.deltas)).toBe("The file greets us.");
    turn.proc.emitStdout(END_LINE);
    await turn.done;
  });

  it("attaches via the realpath-encoded cwd grok actually writes", async () => {
    const target = path.join(osMockState.home, "cwd-real");
    const link = path.join(osMockState.home, "cwd-link");
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, link);
    const sessionsRoot = path.join(
      osMockState.home,
      ".grok",
      "sessions",
      encodeURIComponent(fs.realpathSync(link)),
    );
    await flush();
    const turn = startFreshTurn(link, "jinn-realpath");
    await flush();

    writeTranscript(sessionsRoot, "real-session", [
      toolCall("real-session", "tool-real"),
      toolCallDone("real-session", "tool-real"),
    ]);
    await waitFor(() => turn.deltas.some((d) => d.type === "tool_use" && d.toolId === "tool-real"), "realpath transcript");
    turn.proc.emitStdout(END_LINE);
    await turn.done;
  });

  it("waits for updates.jsonl rather than the sibling files grok writes first", async () => {
    const { cwd, sessionsRoot } = makeCwd("cwd-late-updates");
    await flush();
    const turn = startFreshTurn(cwd, "jinn-late-updates");
    await flush();

    const dir = path.join(sessionsRoot, "late-session");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "chat_history.jsonl"), "{}\n");
    fs.writeFileSync(path.join(dir, "events.jsonl"), "{}\n");
    await sleep(500);
    expect(turn.deltas.filter((d) => d.type === "tool_use")).toEqual([]);

    writeTranscript(sessionsRoot, "late-session", [
      toolCall("late-session", "tool-late"),
      toolCallDone("late-session", "tool-late"),
    ]);
    await waitFor(() => turn.deltas.some((d) => d.type === "tool_result"), "late updates.jsonl tool result");
    turn.proc.emitStdout(END_LINE);
    await turn.done;
    expect(turn.deltas.some((d) => d.type === "tool_use" && d.toolId === "tool-late")).toBe(true);
  });

  it("refuses to attach while two fresh transcripts share the cwd", async () => {
    const { cwd, sessionsRoot } = makeCwd("cwd-shared");
    await flush();
    const turn = startFreshTurn(cwd, "jinn-ambiguous");
    await flush();

    writeTranscript(sessionsRoot, "concurrent-a", [toolCall("concurrent-a", "tool-a")]);
    writeTranscript(sessionsRoot, "concurrent-b", [toolCall("concurrent-b", "tool-b")]);

    await sleep(700);
    expect(turn.deltas.filter((d) => d.type === "tool_use")).toEqual([]);
    turn.proc.emitStdout(END_LINE);
    await turn.done;
  });
});

describe("GrokEngine — live line and block seams while the turn is still running", () => {
  it("keeps grok's paragraph newline chunks in the live stream before end", async () => {
    const { cwd } = makeCwd("cwd-newlines");
    await flush();
    const turn = startFreshTurn(cwd, "jinn-newlines");
    await flush();

    turn.proc.emitStdout(JSON.stringify({ type: "text", data: "I read the file" }) + "\n");
    turn.proc.emitStdout(JSON.stringify({ type: "text", data: ".\n\n" }) + "\n");
    expect(streamedText(turn.deltas)).toBe("I read the file.\n\n");
    expect(streamedText(turn.deltas)).not.toContain("file.The");

    turn.proc.emitStdout(JSON.stringify({ type: "text", data: "\"hello from the file\"" }) + "\n");
    expect(streamedText(turn.deltas)).toBe("I read the file.\n\n\"hello from the file\"");
    turn.proc.emitStdout(END_LINE);
    await turn.done;
  });

  it("separates two text runs split by a reasoning run before end, and leaks no reasoning", async () => {
    const { cwd } = makeCwd("cwd-blocks");
    await flush();
    const turn = startFreshTurn(cwd, "jinn-blocks");
    await flush();

    turn.proc.emitStdout(JSON.stringify({ type: "text", data: "I'll read it and answer in two short paragraphs." }) + "\n");
    turn.proc.emitStdout(JSON.stringify({ type: "thought", data: "DRAFT-ONLY-REASONING: the user wants a summary." }) + "\n");
    turn.proc.emitStdout(JSON.stringify({ type: "text", data: "The file note.txt contains a greeting." }) + "\n");

    const streamed = turn.deltas.filter((d) => d.type === "text").map((d) => d.content);
    expect(streamed).toEqual([
      "I'll read it and answer in two short paragraphs.",
      "\n\nThe file note.txt contains a greeting.",
    ]);
    expect(streamed.join("")).not.toContain("paragraphs.The file");
    for (const delta of turn.deltas) expect(String(delta.content)).not.toContain("DRAFT-ONLY-REASONING");

    turn.proc.emitStdout(END_LINE);
    const result = await turn.done;
    expect(result.result).toBe("I'll read it and answer in two short paragraphs.\n\nThe file note.txt contains a greeting.");
  });

  it("does not insert a break the answer already carries", async () => {
    const { cwd } = makeCwd("cwd-own-break");
    await flush();
    const turn = startFreshTurn(cwd, "jinn-own-break");
    await flush();
    turn.proc.emitStdout(JSON.stringify({ type: "text", data: "First paragraph.\n\n" }) + "\n");
    turn.proc.emitStdout(JSON.stringify({ type: "thought", data: "reasoning" }) + "\n");
    turn.proc.emitStdout(JSON.stringify({ type: "text", data: "Second paragraph." }) + "\n");
    expect(streamedText(turn.deltas)).toBe("First paragraph.\n\nSecond paragraph.");
    turn.proc.emitStdout(END_LINE);
    const result = await turn.done;
    expect(result.result).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("drops an agent_thought_chunk without emitting any delta for it", async () => {
    const { cwd } = makeCwd("cwd-thought-chunk");
    await flush();
    const turn = startFreshTurn(cwd, "jinn-thought-chunk");
    await flush();
    turn.proc.emitStdout([
      JSON.stringify({
        method: "session/update",
        params: {
          sessionId: "thought-session",
          update: { sessionUpdate: "agent_thought_chunk", content: { text: "HIDDEN-CHAIN-OF-THOUGHT" } },
        },
      }),
      JSON.stringify({ type: "text", data: "Answer." }),
      "",
    ].join("\n"));
    expect(streamedText(turn.deltas)).toBe("Answer.");
    for (const delta of turn.deltas) expect(String(delta.content)).not.toContain("HIDDEN-CHAIN-OF-THOUGHT");
    turn.proc.emitStdout(END_LINE);
    await turn.done;
  });

  it("restarts the canonical result at a live tool card so earlier text is not rendered twice", async () => {
    const { cwd, sessionsRoot } = makeCwd("cwd-tool-split");
    await flush();
    const turn = startFreshTurn(cwd, "jinn-tool-split");
    await flush();
    turn.proc.emitStdout(JSON.stringify({ type: "text", data: "Let me read the file." }) + "\n");
    writeTranscript(sessionsRoot, "split-session", [
      toolCall("split-session", "tool-2"),
      toolCallDone("split-session", "tool-2"),
    ]);
    await waitFor(() => turn.deltas.some((d) => d.type === "tool_result"), "tool-split tool result");
    expect(streamedText(turn.deltas)).toBe("Let me read the file.");

    turn.proc.emitStdout(JSON.stringify({ type: "text", data: "It contains a greeting." }) + "\n");
    expect(streamedText(turn.deltas)).toBe("Let me read the file.It contains a greeting.");
    turn.proc.emitStdout(END_LINE);
    const result = await turn.done;
    expect(result.result).toBe("It contains a greeting.");
  });
});
