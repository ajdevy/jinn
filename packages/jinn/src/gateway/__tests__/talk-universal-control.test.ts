import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiContext } from "../api.js";
import type { Engine, JinnConfig } from "../../shared/types.js";
import type { WorkflowService } from "../../workflows/service.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-talk-universal-control-"));
process.env.JINN_HOME = home;
fs.mkdirSync(path.join(home, "org", "platform"), { recursive: true });
fs.writeFileSync(path.join(home, "org", "platform", "a-worker.yaml"), [
  "name: a-worker",
  "displayName: A Worker",
  "department: platform",
  "rank: senior",
  "engine: test-engine",
  "model: test-model",
  "persona: Complete bounded platform work.",
  "",
].join("\n"));

let handleApiRequest: typeof import("../api.js").handleApiRequest;
let workItems: typeof import("../../work-items/store.js");
let comments: typeof import("../../work-items/comments.js");
let sessions: typeof import("../../sessions/registry.js");
let buildManifest: typeof import("../../talk/control/manifest.js").buildTalkControlManifest;

beforeAll(async () => {
  ({ handleApiRequest } = await import("../api.js"));
  workItems = await import("../../work-items/store.js");
  comments = await import("../../work-items/comments.js");
  sessions = await import("../../sessions/registry.js");
  ({ buildTalkControlManifest: buildManifest } = await import("../../talk/control/manifest.js"));
  (await import("../../shared/db.js")).initDb();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  (await import("../../shared/db.js")).__closeDbForTest();
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
});

function request(method: string, url: string, body?: unknown, authorized = true) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method,
    url,
    headers: {
      host: "localhost",
      "content-type": "application/json",
      ...(authorized ? { authorization: "Bearer test-token" } : {}),
    },
  });
  return req as unknown as Parameters<typeof handleApiRequest>[0];
}

function response() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    setHeader: vi.fn(),
    writeHead(code: number) { status = code; return this; },
    write(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)); return true; },
    end(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)); },
  } as unknown as ServerResponse;
  return {
    res,
    read: () => ({
      status,
      body: chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
        : {},
    }),
  };
}

interface RunRecord {
  id: string;
  workflowId: string;
  status: "completed";
  revision: number;
  input: Record<string, unknown>;
}

function testContext() {
  const config = {
    gateway: {},
    engines: { default: "test-engine" },
    realtime: { provider: "openai", apiKey: "test-realtime-key", model: "test-realtime-model" },
  } as unknown as JinnConfig;
  const runs = new Map<string, RunRecord>();
  const startManual = vi.fn(async (input: {
    workflowId: string;
    input: Record<string, unknown>;
    idempotencyKey?: string;
  }) => {
    const key = input.idempotencyKey ?? `unkeyed:${runs.size}`;
    const existing = runs.get(key);
    if (existing) return existing;
    const run: RunRecord = {
      id: `run-${runs.size + 1}`,
      workflowId: input.workflowId,
      status: "completed",
      revision: 1,
      input: input.input,
    };
    runs.set(key, run);
    return run;
  });
  const workflowService = {
    startManual,
    getRun: (workflowId: string, runId: string) =>
      [...runs.values()].find((run) => run.workflowId === workflowId && run.id === runId),
    listRuns: (workflowId: string) => ({
      items: [...runs.values()].filter((run) => run.workflowId === workflowId),
      nextCursor: null,
    }),
  } as unknown as WorkflowService;
  const engine: Engine = {
    name: "test-engine",
    run: async () => ({ sessionId: "test-native-session", result: "Done." }),
  };
  const queue = {
    enqueue: vi.fn(async () => undefined),
    getPendingCount: () => 0,
    getTransportState: (_key: string, status: string) => status,
  };
  const context = {
    gatewayAuthToken: "test-token",
    getConfig: () => config,
    connectors: new Map(),
    startTime: Date.now(),
    emit: vi.fn(),
    workflowService,
    sessionManager: {
      getEngine: (name: string) => name === engine.name ? engine : undefined,
      getEngines: () => new Map([[engine.name, engine]]),
      getQueue: () => queue,
    },
  } as unknown as ApiContext;
  return { context, startManual };
}

async function call(context: ApiContext, method: string, url: string, body?: unknown, authorized = true) {
  const capture = response();
  await handleApiRequest(request(method, url, body, authorized), capture.res, context);
  return capture.read();
}

function control(providerCallId: string, tool: string, args: Record<string, unknown>) {
  return { providerCallId, tool, arguments: JSON.stringify(args) };
}

describe("universal Talk gateway control acceptance", () => {
  it("routes representative Todo, delegation, chat, and Workflow writes once with verified UI effects", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({ value: "test-ephemeral-token", expires_at: Math.floor(Date.now() / 1000) + 600 }),
    }));
    const { context, startManual } = testContext();
    const todo = workItems.createWorkItem({ title: "Prepare the operator brief", body: "Draft the first version." });
    const opened = await call(context, "POST", "/api/talk/sessions");
    expect(opened.status).toBe(201);
    const talkId = String(opened.body.id);
    const route = `/api/talk/sessions/${talkId}/control`;

    const manifest = buildManifest();
    const names = new Set([
      "talk_edit_todo",
      "talk_comment_todo",
      "talk_assign_todo",
      "talk_delegate_todo",
      "talk_send_to_session",
      "talk_start_workflow_run",
    ]);
    const journeyOperations = manifest.operations.filter((operation) => names.has(operation.name));
    expect(journeyOperations).toHaveLength(names.size);
    expect(journeyOperations.every((operation) => operation.target === "gateway" && operation.operatorOnly)).toBe(true);

    const edit = control("edit-1", "talk_edit_todo", {
      id: todo.id,
      expectedVersion: todo.version,
      title: "Prepare the verified operator brief",
      priority: 2,
    });
    const edited = await call(context, "POST", route, edit);
    const editReplay = await call(context, "POST", route, edit);
    expect(edited.body).toMatchObject({
      ok: true,
      operation: "talk_edit_todo",
      verified: true,
      replayed: false,
      uiEffect: { navigate: `/todos/${todo.id}` },
    });
    expect(editReplay.body).toMatchObject({ ok: true, replayed: true, receiptId: edited.body.receiptId });
    expect(workItems.getWorkItem(todo.id)).toMatchObject({
      title: "Prepare the verified operator brief",
      priority: 2,
      version: todo.version + 1,
    });

    const comment = control("comment-1", "talk_comment_todo", { id: todo.id, body: "The acceptance evidence is attached." });
    const commented = await call(context, "POST", route, comment);
    await call(context, "POST", route, comment);
    expect(commented.body).toMatchObject({ ok: true, operation: "talk_comment_todo", verified: true, replayed: false });
    expect(comments.listComments(todo.id).comments.map((entry) => entry.body))
      .toEqual(["The acceptance evidence is attached."]);

    const beforeAssignment = workItems.getWorkItem(todo.id)!;
    const assignment = control("assign-1", "talk_assign_todo", { id: todo.id, assignee: "a-worker" });
    const assigned = await call(context, "POST", route, assignment);
    const assignedReplay = await call(context, "POST", route, assignment);
    expect(assigned.body).toMatchObject({
      ok: true,
      verified: true,
      evidence: { id: todo.id, assignee: "a-worker" },
      uiEffect: { navigate: `/todos/${todo.id}` },
    });
    expect(assignedReplay.body).toMatchObject({ ok: true, replayed: true, receiptId: assigned.body.receiptId });
    expect(workItems.getWorkItem(todo.id)).toMatchObject({
      assignee: "a-worker",
      version: beforeAssignment.version + 1,
    });

    const delegation = control("delegate-1", "talk_delegate_todo", {
      id: todo.id,
      employee: "a-worker",
      task: "Complete the bounded verification task.",
    });
    const delegated = await call(context, "POST", route, delegation);
    const delegatedReplay = await call(context, "POST", route, delegation);
    expect(delegated.body).toMatchObject({
      ok: true,
      operation: "talk_delegate_todo",
      verified: true,
      replayed: false,
      data: { todoId: todo.id, employee: "a-worker" },
    });
    expect(delegatedReplay.body).toMatchObject({ ok: true, replayed: true, receiptId: delegated.body.receiptId });
    const delegatedSessions = sessions.listSessionsByWorkItem(todo.id);
    expect(delegatedSessions).toHaveLength(1);
    const delegatedSession = delegatedSessions[0]!;
    expect(delegated.body).toMatchObject({ uiEffect: { navigate: `/?session=${delegatedSession.id}` } });

    const message = control("message-1", "talk_send_to_session", {
      id: delegatedSession.id,
      message: "Please include the final evidence summary.",
    });
    const sent = await call(context, "POST", route, message);
    const sentReplay = await call(context, "POST", route, message);
    expect(sent.body).toMatchObject({
      ok: true,
      operation: "talk_send_to_session",
      verified: true,
      replayed: false,
      evidence: { sessionId: delegatedSession.id },
      uiEffect: { navigate: `/?session=${delegatedSession.id}` },
    });
    expect(sentReplay.body).toMatchObject({ ok: true, replayed: true, receiptId: sent.body.receiptId });
    expect(sessions.getMessages(delegatedSession.id).filter((entry) => entry.role === "user").map((entry) => entry.content))
      .toEqual(["Complete the bounded verification task.", "Please include the final evidence summary."]);

    const workflow = control("workflow-1", "talk_start_workflow_run", {
      id: "verification-flow",
      input: JSON.stringify({ artifact: "acceptance-summary" }),
    });
    const started = await call(context, "POST", route, workflow);
    const startedReplay = await call(context, "POST", route, workflow);
    expect(started.body).toMatchObject({
      ok: true,
      operation: "talk_start_workflow_run",
      verified: true,
      replayed: false,
      data: { workflowId: "verification-flow", runId: "run-1", status: "completed" },
      evidence: { workflowId: "verification-flow", runId: "run-1", status: "completed" },
      uiEffect: { navigate: "/workflow/verification-flow/runs/run-1" },
    });
    expect(startedReplay.body).toMatchObject({ ok: true, replayed: true, receiptId: started.body.receiptId });
    expect(startManual).toHaveBeenCalledTimes(1);
    expect(startManual).toHaveBeenCalledWith({
      workflowId: "verification-flow",
      input: { artifact: "acceptance-summary" },
      idempotencyKey: `talk:${talkId}:workflow-1`,
    });

    const commentCount = comments.listComments(todo.id).comments.length;
    const rejected = await call(context, "POST", route,
      control("comment-unauthorized", "talk_comment_todo", { id: todo.id, body: "Must not be written." }), false);
    expect(rejected).toMatchObject({ status: 401 });
    expect(comments.listComments(todo.id).comments).toHaveLength(commentCount);
    expect(manifest.operations.filter((operation) => operation.mutability === "write" && !operation.operatorOnly)).toEqual([]);
  });
});
