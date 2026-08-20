import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Employee, ModelRegistry, WorkflowAttemptCommand, WorkflowAttemptCompletionListener } from "../../shared/types.js";
import type { WorkflowDefinition, WorkflowNode } from "../model.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";

// What a Wait in todo-comment mode harvests off the resuming reply, and what a
// downstream node can then bind to. Same real work-items store the gateway
// writes to, so the attachment rows are the production ones.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wait-comment-attachments-"));
process.env.JINN_HOME = home;

type Attachments = typeof import("../../work-items/attachments.js");
type Comments = typeof import("../../work-items/comments.js");
type Store = typeof import("../../work-items/store.js");
type Migrations = typeof import("../repository-migrations.js");
type Repository = typeof import("../repository.js");
type Service = typeof import("../service.js");

let attachments: Attachments;
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

/** The operator's reply carries a file. Distinct bytes per filename so the
 *  content-addressed store keeps them as separate rows. */
function attach(workItemId: string, commentId: string | null, filename: string, mime: string): string {
  return attachments.addAttachment({
    workItemId, commentId, filename, mime,
    stagedPath: attachments.stageAttachmentBuffer(Buffer.from(`bytes of ${filename}`)),
    uploader: { author: "operator", authorKind: "operator", operator: true },
  }).id;
}

function refOf(workItemId: string, attachmentId: string, mime: string): string {
  return `attachment:${workItemId}:${attachmentId}:${mime}`;
}

/** start → hold → route → with-files / no-files. The Condition binds
 *  `node.hold.fields.attachments` directly, so which end the run reaches proves
 *  a downstream node received what the Wait harvested — on both endings. */
function saveRoutingDefinition(id: string): WorkflowDefinition {
  const draft = service.createDefinition({ id, title: id });
  const nodes: WorkflowNode[] = [
    { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
    { id: "hold", type: "wait", name: "Ask operator", config: { mode: "todo-comment", timeoutMinutes: TIMEOUT_MINUTES } },
    { id: "route", type: "condition", name: "Any files?", config: {
      cases: [{ port: "files", label: "With files", all: [{
        left: { source: "node", nodeId: "hold", path: "fields.attachments" }, operator: "not-equals",
        right: { source: "fixed", value: [] },
      }] }],
      defaultPort: "none",
    } },
    { id: "with-files", type: "end", name: "With files", config: { result: "success" } },
    { id: "no-files", type: "end", name: "No files", config: { result: "success" } },
  ];
  const saved = service.saveDefinition({ ...draft, nodes, edges: [
    edge("start-hold", "start", "hold"),
    edge("hold-route", "hold", "route"),
    { id: "route-files", from: { nodeId: "route", port: "files" }, to: { nodeId: "with-files", port: "input" as const } },
    { id: "route-none", from: { nodeId: "route", port: "none" }, to: { nodeId: "no-files", port: "input" as const } },
  ] }, draft.revision);
  return service.setEnabled({ id, enabled: true, expectedRevision: saved.revision });
}

function nodeOf(workflowId: string, runId: string, nodeId = "hold") {
  return service.getRun(workflowId, runId)!.nodeRuns.find((node) => node.nodeId === nodeId)!;
}

beforeAll(async () => {
  attachments = await import("../../work-items/attachments.js");
  comments = await import("../../work-items/comments.js");
  store = await import("../../work-items/store.js");
  migrations = await import("../repository-migrations.js");
  repositoryModule = await import("../repository.js");
  serviceModule = await import("../service.js");
});

beforeEach(() => {
  vi.useFakeTimers();
  advanceTo(PARK_AT);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wait-comment-attachments-db-"));
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

describe("Wait todo-comment attachments", () => {
  it("harvests the reply's attachments as refs, alongside the unchanged reply fields", async () => {
    const definition = saveWaitDefinition("attachment-flow");
    const todoId = todo("Shape the intake");
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId });

    advanceTo("2026-07-21T12:10:00.000Z");
    const comment = comments.addComment({ workItemId: todoId, body: "Like this.", author: "operator", authorKind: "operator" });
    const shot = attach(todoId, comment.id, "shot.png", "image/png");
    const notes = attach(todoId, comment.id, "notes.pdf", "application/pdf");
    await service.recover(now);

    expect(nodeOf(definition.id, run.id).output?.fields).toEqual({
      outcome: "reply",
      commentId: comment.id,
      comment: "Like this.",
      attachments: [refOf(todoId, shot, "image/png"), refOf(todoId, notes, "application/pdf")],
    });
  });

  it("gives a reply with no attachments an empty list", async () => {
    const definition = saveWaitDefinition("bare-reply-flow");
    const todoId = todo("Shape the intake");
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId });

    advanceTo("2026-07-21T12:10:00.000Z");
    comments.addComment({ workItemId: todoId, body: "No file.", author: "operator", authorKind: "operator" });
    await service.recover(now);

    expect(nodeOf(definition.id, run.id).output?.fields).toMatchObject({ attachments: [] });
  });

  it("harvests only the resuming comment's own attachments", async () => {
    const definition = saveWaitDefinition("scoped-attachment-flow");
    const todoId = todo("Shape the intake");
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId });
    attach(todoId, null, "item-level.png", "image/png");

    advanceTo("2026-07-21T12:10:00.000Z");
    const answer = comments.addComment({ workItemId: todoId, body: "Mine.", author: "operator", authorKind: "operator" });
    const mine = attach(todoId, answer.id, "mine.png", "image/png");
    const other = comments.addComment({ workItemId: todoId, body: "Theirs.", author: "jinn-dev", authorKind: "employee" });
    attach(todoId, other.id, "theirs.png", "image/png");
    await service.recover(now);

    expect(nodeOf(definition.id, run.id).output?.fields).toMatchObject({
      attachments: [refOf(todoId, mine, "image/png")],
    });
  });

  it("carries the harvested refs into a downstream node's binding", async () => {
    const definition = saveRoutingDefinition("routing-flow");
    const todoId = todo("Shape the intake");
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId });

    advanceTo("2026-07-21T12:10:00.000Z");
    const comment = comments.addComment({ workItemId: todoId, body: "Look.", author: "operator", authorKind: "operator" });
    attach(todoId, comment.id, "shot.png", "image/png");
    await service.recover(now);

    const settled = service.getRun(definition.id, run.id)!;
    expect(settled.status).toBe("completed");
    expect(settled.nodeRuns.find((node) => node.nodeId === "with-files")).toMatchObject({ status: "completed" });
  });

  it("resolves that same binding on the timeout branch rather than failing the run", async () => {
    const definition = saveRoutingDefinition("routing-timeout-flow");
    const todoId = todo("Shape the intake");
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId });

    advanceTo("2026-07-21T13:00:00.000Z");
    await service.recover(now);

    const settled = service.getRun(definition.id, run.id)!;
    expect(settled.status).toBe("completed");
    expect(settled.nodeRuns.find((node) => node.nodeId === "no-files")).toMatchObject({ status: "completed" });
  });
});
