import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

// JINN_HOME decides where the sessions DB and the per-session codex homes live,
// and both are resolved at module load — so it has to be set before the imports.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-attempt-continuation-"));
process.env.JINN_HOME = home;
process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-real-codex-home-"));
const registry = await import("../registry.js");
const { continueWorkflowAttemptSession, resumableEngineSession } = await import("../attempt-continuation.js");

const CODEX_HOMES = path.join(home, "tmp", "codex-homes");

function session(engine: string, engineSessionId?: string) {
  const created = registry.createSession({ engine, source: "workflow", sourceRef: `ref-${Math.random()}`, employee: "worker" });
  return engineSessionId ? registry.recordEngineSessionId(created.id, engine, engineSessionId)! : created;
}

/** Write a rollout for `threadId` where codex would have left it for `sessionId`. */
function writeRollout(sessionId: string, threadId: string): string {
  const dir = path.join(CODEX_HOMES, sessionId, "sessions", "2026", "08", "01");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-08-01T00-00-00-${threadId}.jsonl`);
  fs.writeFileSync(file, `{"payload":{"id":"${threadId}"}}\n`);
  return file;
}

beforeEach(async () => {
  const db = (await import("../../shared/db.js")).initDb();
  db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  fs.rmSync(CODEX_HOMES, { recursive: true, force: true });
});

describe("whether an attempt session can be continued", () => {
  it("reports the engine thread a completed attempt still holds", () => {
    const source = session("claude", "claude-thread");
    expect(resumableEngineSession(source.id, "claude")).toBe("claude-thread");
  });

  it.each([
    ["the session is gone", () => "missing-session-id", "claude"],
    ["it ran on another engine", () => session("claude", "claude-thread").id, "codex"],
    ["it never recorded a thread", () => session("claude").id, "claude"],
  ])("is null when %s", (_label, subject: () => string, engine) => {
    expect(resumableEngineSession(subject(), engine)).toBeNull();
  });

  it("is null for a codex thread whose rollout has been swept, and not before", () => {
    const source = session("codex", "codex-thread");
    expect(resumableEngineSession(source.id, "codex")).toBeNull();
    writeRollout(source.id, "codex-thread");
    expect(resumableEngineSession(source.id, "codex")).toBe("codex-thread");
  });
});

describe("seeding a new attempt session with the session it continues", () => {
  it("carries the engine session ref onto the new row", () => {
    const target = session("claude");
    const seeded = continueWorkflowAttemptSession(target, { engine: "claude", engineSessionId: "claude-thread", sourceSessionId: "source-session" });

    expect(registry.getEngineSessionRef(seeded, "claude").id).toBe("claude-thread");
    expect(registry.getSession(target.id)?.engineSessionId).toBe("claude-thread");
  });

  it("copies the codex rollout into the new session's home so the resume finds it", () => {
    const source = session("codex", "codex-thread");
    writeRollout(source.id, "codex-thread");
    const target = session("codex");

    const seeded = continueWorkflowAttemptSession(target, { engine: "codex", engineSessionId: "codex-thread", sourceSessionId: source.id });

    expect(registry.getEngineSessionRef(seeded, "codex").id).toBe("codex-thread");
    expect(fs.existsSync(path.join(CODEX_HOMES, target.id, "sessions", "2026", "08", "01",
      "rollout-2026-08-01T00-00-00-codex-thread.jsonl"))).toBe(true);
  });

  it("leaves the session cold when the codex rollout is missing from the source home", () => {
    const target = session("codex");

    const seeded = continueWorkflowAttemptSession(target, { engine: "codex", engineSessionId: "codex-thread", sourceSessionId: "swept-session" });

    expect(registry.getEngineSessionRef(seeded, "codex").id).toBeUndefined();
    expect(registry.getSession(target.id)?.engineSessionId).toBeNull();
    expect(fs.existsSync(path.join(CODEX_HOMES, target.id))).toBe(false);
  });

  it("leaves the session cold when the copy itself cannot be made", () => {
    const source = session("codex", "codex-thread");
    writeRollout(source.id, "codex-thread");
    const target = session("codex");
    // A file where the target's home has to go: the copy raises rather than
    // reporting a missing rollout, and that must still land on a cold dispatch.
    fs.mkdirSync(CODEX_HOMES, { recursive: true });
    fs.writeFileSync(path.join(CODEX_HOMES, target.id), "not a directory");

    const seeded = continueWorkflowAttemptSession(target, { engine: "codex", engineSessionId: "codex-thread", sourceSessionId: source.id });

    expect(registry.getEngineSessionRef(seeded, "codex").id).toBeUndefined();
  });

  it("does nothing without a continuation, and never overwrites a ref the session already has", () => {
    const untouched = session("claude", "own-thread");
    expect(continueWorkflowAttemptSession(untouched, undefined)).toBe(untouched);

    const seeded = continueWorkflowAttemptSession(untouched, { engine: "claude", engineSessionId: "claude-thread", sourceSessionId: "source-session" });
    expect(registry.getEngineSessionRef(seeded, "claude").id).toBe("own-thread");
  });
});
