import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Employee, ModelRegistry, WorkflowAttemptCommand, WorkflowAttemptCompletionListener } from "../../shared/types.js";
import type { WorkflowDefinition, WorkflowNode } from "../model.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";

// The point of this suite is that the operator/employee discrimination is the
// REAL one: the service reads comments through the same work-items store the
// gateway writes them to, so a comment authored by an employee slugged
// "operator" is rejected here exactly as it is in production.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wait-todo-comment-"));
process.env.JINN_HOME = home;

type Comments = typeof import("../../work-items/comments.js");
type Store = typeof import("../../work-items/store.js");
type Migrations = typeof import("../repository-migrations.js");
type Repository = typeof import("../repository.js");
type Service = typeof import("../service.js");

let comments: Comments;
let store: Store;
let migrations: Migrations;
let repositoryModule: Repository;
let serviceModule: Service;

const employee: Employee = { name: "worker", displayName: "Worker", department: "platform", rank: "employee",
  engine: "test-engine", model: "test-model", effortLevel: "high", persona: "Complete work." };
const models: ModelRegistry = { "test-engine": { name: "test-engine", available: true, defaultModel: "test-model",
  effortMechanism: "codex-config", models: [{ id: "test-model", label: "Test", supportsEffort: true, effortLevels: ["high"] }] } };

class Executor {
  readonly commands: WorkflowAttemptCommand[] = [];
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();
  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    this.commands.push(command); return { sessionId: `session:${command.owner.runId}:${command.owner.nodeId}:${command.owner.attempt}` };
  }
  async stopAttempt(): Promise<void> {}
  subscribe(listener: WorkflowAttemptCompletionListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  readTerminalCompletion(): null { return null; }
}

const PARK_AT = "2026-07-21T12:00:00.000Z";
const TIMEOUT_MINUTES = 60;

let root: string;
let database: Database.Database;
let repository: InstanceType<Repository["WorkflowRepository"]>;
let executor: Executor;
let service: InstanceType<Service["WorkflowService"]>;
let now: string;

/** Move both clocks together: the workflow service reads the injected `now`,
 *  while `addComment` stamps rows off the system clock. */
function advanceTo(iso: string): void {
  now = iso;
  vi.setSystemTime(new Date(iso));
}

function buildService(): InstanceType<Service["WorkflowService"]> {
  return new serviceModule.WorkflowService({ repository, executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]), models: () => models, now: () => now,
    todoComments: { firstOperatorCommentAfter: comments.firstOperatorCommentAfter } });
}

function edge(id: string, from: string, to: string) {
  return { id, from: { nodeId: from, port: "success" as const }, to: { nodeId: to, port: "input" as const } };
}

function saveWaitDefinition(id: string): WorkflowDefinition {
  const draft = service.createDefinition({ id, title: id });
  const nodes: WorkflowNode[] = [
    { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
    { id: "hold", type: "wait", name: "Ask operator", config: { mode: "todo-comment", timeoutMinutes: TIMEOUT_MINUTES } },
    { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
  ];
  const saved = service.saveDefinition({ ...draft, nodes,
    edges: [edge("start-hold", "start", "hold"), edge("hold-finish", "hold", "finish")] }, draft.revision);
  return service.setEnabled({ id, enabled: true, expectedRevision: saved.revision });
}

function todo(title: string): string {
  return store.createWorkItem({ title, department: "platform", source: "human" }).id;
}

function nodeOf(workflowId: string, runId: string, nodeId = "hold") {
  return service.getRun(workflowId, runId)!.nodeRuns.find((node) => node.nodeId === nodeId)!;
}

beforeAll(async () => {
  comments = await import("../../work-items/comments.js");
  store = await import("../../work-items/store.js");
  migrations = await import("../repository-migrations.js");
  repositoryModule = await import("../repository.js");
  serviceModule = await import("../service.js");
});

beforeEach(() => {
  vi.useFakeTimers();
  advanceTo(PARK_AT);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wait-todo-comment-db-"));
  database = migrations.openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new repositoryModule.WorkflowRepository(database, () => now);
  executor = new Executor();
  service = buildService();
});

// Both teardowns close the handle before removing what holds it, on one line each like the
// sibling recovery suite. POSIX lets a directory go with its database still open; Windows
// answers EPERM and fails the whole file, and the work-items store's singleton lives in `home`.
afterEach(() => { service.dispose(); database.close(); fs.rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
afterAll(async () => { (await import("../../shared/db.js")).__closeDbForTest(); fs.rmSync(home, { recursive: true, force: true }); });

describe("Wait todo-comment mode", () => {
  it("parks a Todo-bound run with the timeout deadline and the canvas config", async () => {
    const definition = saveWaitDefinition("park-flow");
    const todoId = todo("Shape the intake");
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId });

    expect(run.status).toBe("waiting");
    expect(nodeOf(definition.id, run.id)).toMatchObject({
      status: "waiting",
      startedAt: PARK_AT,
      resumeAt: "2026-07-21T13:00:00.000Z",
      resolvedConfig: { mode: "todo-comment", todoId, timeoutMinutes: TIMEOUT_MINUTES },
    });
  });

  it("resumes on an operator comment, exposing it as the reply outcome", async () => {
    const definition = saveWaitDefinition("reply-flow");
    const todoId = todo("Shape the intake");
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId });

    advanceTo("2026-07-21T12:10:00.000Z");
    const comment = comments.addComment({ workItemId: todoId, body: "Ship variant B.", author: "operator", authorKind: "operator" });
    await service.recover(now);

    expect(nodeOf(definition.id, run.id)).toMatchObject({
      status: "completed",
      output: { fields: { outcome: "reply", commentId: comment.id, comment: "Ship variant B." } },
    });
    const settled = service.getRun(definition.id, run.id)!;
    expect(settled.status).toBe("completed");
    expect(settled.nodeRuns.find((node) => node.nodeId === "finish")).toMatchObject({ status: "completed" });
  });

  it.each([
    ["an employee", { author: "jinn-dev", authorKind: "employee" as const }],
    ["a workflow", { author: "workflow", authorKind: "system" as const }],
    ["an employee slugged operator", { author: "operator", authorKind: "employee" as const }],
  ])("does not resume on a comment by %s", async (_label, author) => {
    const definition = saveWaitDefinition("actor-flow");
    const todoId = todo("Shape the intake");
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId });

    advanceTo("2026-07-21T12:10:00.000Z");
    comments.addComment({ workItemId: todoId, body: "Working on it.", ...author });
    await service.recover(now);

    expect(service.getRun(definition.id, run.id)!.status).toBe("waiting");
    expect(nodeOf(definition.id, run.id).status).toBe("waiting");
  });

  it("ignores an operator comment posted before the node parked", async () => {
    const definition = saveWaitDefinition("watermark-flow");
    const todoId = todo("Shape the intake");
    comments.addComment({ workItemId: todoId, body: "Early thought.", author: "operator", authorKind: "operator" });

    advanceTo("2026-07-21T12:05:00.000Z");
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId });
    expect(run.status).toBe("waiting");

    advanceTo("2026-07-21T12:06:00.000Z");
    await service.recover(now);
    expect(service.getRun(definition.id, run.id)!.status).toBe("waiting");
  });

  it("resumes every run parked on the same Todo from one comment", async () => {
    const definition = saveWaitDefinition("shared-todo-flow");
    const todoId = todo("Shape the intake");
    const first = await service.startManual({ workflowId: definition.id, input: {}, todoId, idempotencyKey: "first" });
    const second = await service.startManual({ workflowId: definition.id, input: {}, todoId, idempotencyKey: "second" });
    expect([first.status, second.status]).toEqual(["waiting", "waiting"]);

    advanceTo("2026-07-21T12:10:00.000Z");
    const comment = comments.addComment({ workItemId: todoId, body: "Both go.", author: "operator", authorKind: "operator" });
    await service.recover(now);

    for (const run of [first, second]) {
      expect(service.getRun(definition.id, run.id)!.status).toBe("completed");
      expect(nodeOf(definition.id, run.id).output?.fields).toMatchObject({ outcome: "reply", commentId: comment.id });
    }
  });

  it("completes with the timeout outcome when the deadline passes uncommented", async () => {
    const definition = saveWaitDefinition("timeout-flow");
    const todoId = todo("Shape the intake");
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId });

    advanceTo("2026-07-21T13:00:00.000Z");
    await service.recover(now);

    const node = nodeOf(definition.id, run.id);
    expect(node.status).toBe("completed");
    expect(node.output?.fields).toEqual({ outcome: "timeout", attachments: [] });
    const settled = service.getRun(definition.id, run.id)!;
    expect(settled.status).toBe("completed");
    expect(settled.nodeRuns.find((item) => item.nodeId === "finish")).toMatchObject({ status: "completed" });
  });

  it("times out rather than answering from a comment posted past the deadline", async () => {
    // The deadline is real even while nobody is listening: a restart that finds
    // both an expired park and a late comment must still time the node out.
    const definition = saveWaitDefinition("late-comment-flow");
    const todoId = todo("Shape the intake");
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId });

    service.dispose();
    advanceTo("2026-07-21T13:01:00.000Z");
    comments.addComment({ workItemId: todoId, body: "Too late.", author: "operator", authorKind: "operator" });

    service = buildService();
    await service.recover(now);

    expect(nodeOf(definition.id, run.id).output?.fields).toEqual({ outcome: "timeout", attachments: [] });
  });

  it("recovers a run parked across a restart and stays idempotent", async () => {
    const definition = saveWaitDefinition("restart-flow");
    const todoId = todo("Shape the intake");
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId });

    service.dispose();
    advanceTo("2026-07-21T12:10:00.000Z");
    comments.addComment({ workItemId: todoId, body: "Answered while you were down.", author: "operator", authorKind: "operator" });

    service = buildService();
    await expect(service.recover(now)).resolves.toEqual({ resumedRuns: 0, resumedWaits: 0, resumedComments: 1 });
    expect(service.getRun(definition.id, run.id)!.status).toBe("completed");

    const revision = service.getRun(definition.id, run.id)!.revision;
    await expect(service.recover(now)).resolves.toEqual({ resumedRuns: 0, resumedWaits: 0, resumedComments: 0 });
    expect(service.getRun(definition.id, run.id)!.revision).toBe(revision);
  });

  it("fails the run when the node is reached with no bound Todo", async () => {
    const definition = saveWaitDefinition("unbound-flow");
    const run = await service.startManual({ workflowId: definition.id, input: {} });

    expect(run.status).toBe("failed");
    expect(run.error?.nodeId).toBe("hold");
    expect(run.error?.message).toMatch(/hold/);
    expect(run.error?.message).toMatch(/Todo/);
    expect(nodeOf(definition.id, run.id).status).not.toBe("waiting");
  });

  it("notifies the comment listener after the write commits, and survives a throwing one", () => {
    const todoId = todo("Shape the intake");
    const seen: string[] = [];
    comments.setTodoCommentListener((comment) => { seen.push(comment.id); throw new Error("listener exploded"); });

    const comment = comments.addComment({ workItemId: todoId, body: "Noted.", author: "operator", authorKind: "operator" });

    expect(seen).toEqual([comment.id]);
    expect(comments.getComment(comment.id)?.body).toBe("Noted.");
    comments.setTodoCommentListener(null);
  });
});

describe("firstOperatorCommentAfter", () => {
  it("returns the earliest operator comment strictly after the watermark", () => {
    advanceTo("2026-07-22T09:00:00.000Z");
    const todoId = todo("Query fixture");
    const watermark = now;

    // Same-instant writes sit ON the watermark, which strict `>` excludes.
    comments.addComment({ workItemId: todoId, body: "On the mark.", author: "operator", authorKind: "operator" });

    advanceTo("2026-07-22T09:01:00.000Z");
    comments.addComment({ workItemId: todoId, body: "Employee noise.", author: "jinn-dev", authorKind: "employee" });
    comments.addComment({ workItemId: todoId, body: "Impostor.", author: "operator", authorKind: "employee" });
    comments.addComment({ workItemId: todoId, body: "System noise.", author: "workflow", authorKind: "system" });
    const deleted = comments.addComment({ workItemId: todoId, body: "Retracted.", author: "operator", authorKind: "operator" });
    comments.tombstoneComment(deleted.id, { author: "operator", authorKind: "operator", operator: true });

    advanceTo("2026-07-22T09:02:00.000Z");
    const wanted = comments.addComment({ workItemId: todoId, body: "The real answer.", author: "operator", authorKind: "operator" });
    advanceTo("2026-07-22T09:03:00.000Z");
    comments.addComment({ workItemId: todoId, body: "A later one.", author: "operator", authorKind: "operator" });

    expect(comments.firstOperatorCommentAfter(todoId, watermark, "2026-07-22T09:30:00.000Z"))
      .toMatchObject({ id: wanted.id, body: "The real answer." });
  });

  it("returns undefined when the Todo has no qualifying comment", () => {
    advanceTo("2026-07-22T10:00:00.000Z");
    const todoId = todo("Empty fixture");
    const watermark = now;
    advanceTo("2026-07-22T10:01:00.000Z");
    comments.addComment({ workItemId: todoId, body: "Employee only.", author: "jinn-dev", authorKind: "employee" });

    expect(comments.firstOperatorCommentAfter(todoId, watermark, "2026-07-22T10:30:00.000Z")).toBeUndefined();
  });

  it("excludes a comment written on or after the deadline", () => {
    advanceTo("2026-07-22T11:00:00.000Z");
    const todoId = todo("Deadline fixture");
    const watermark = now;
    const deadline = "2026-07-22T11:05:00.000Z";

    advanceTo(deadline);
    // The deadline instant belongs to the timeout: the node stops waiting there.
    comments.addComment({ workItemId: todoId, body: "On the deadline.", author: "operator", authorKind: "operator" });
    advanceTo("2026-07-22T11:06:00.000Z");
    comments.addComment({ workItemId: todoId, body: "After the deadline.", author: "operator", authorKind: "operator" });

    expect(comments.firstOperatorCommentAfter(todoId, watermark, deadline)).toBeUndefined();
  });
});
