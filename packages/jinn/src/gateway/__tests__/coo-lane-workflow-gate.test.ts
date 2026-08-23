import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";
import type { WorkflowDefinition, WorkflowNode } from "../../workflows/model.js";
import type { WorkflowSessionExecutor } from "../../workflows/session-executor.js";

/**
 * A land gate the COO may decide, and the three sessions that may not.
 *
 * The reservation this class replaces, `operatorOnly`, is also the token that
 * lets an approved run close its bound Todo — so the COO's authority had to
 * become a second class rather than that flag dropped. What makes the class safe
 * is not that the COO has no employee: every child session anyone spawns has no
 * employee either. It is the whole portal shape — no employee, no PARENT, no
 * workflow provenance — which no session an employee can mint ever has.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-coo-workflow-gate-"));
process.env.JINN_HOME = tmp;
fs.mkdirSync(path.join(tmp, "org"), { recursive: true });
fs.writeFileSync(
  path.join(tmp, "org", "platform-worker.yaml"),
  "name: platform-worker\ndisplayName: Platform Worker\ndepartment: platform\nrank: employee\nengine: codex\nmodel: gpt-5.5\npersona: Generic route-test worker.\n",
);

type Api = typeof import("../api.js");
type Reg = typeof import("../../sessions/registry.js");
type Store = typeof import("../../work-items/store.js");
type Approvals = typeof import("../../work-items/approvals.js");
let api: Api;
let reg: Reg;
let store: Store;
let approvals: Approvals;
let database: Database.Database;
let repository: import("../../workflows/repository.js").WorkflowRepository;
let service: import("../../workflows/service.js").WorkflowService;
let ctx: import("../api.js").ApiContext;

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    end(buf?: Buffer | string) { if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try { return JSON.parse(raw) as Record<string, string>; } catch { return { raw } as Record<string, string>; }
    },
  };
}

function toolHeaders(sessionId: string): Record<string, string> {
  return {
    authorization: "Bearer test-token",
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

async function post(urlPath: string, body: Record<string, unknown>, headers: Record<string, string>) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST",
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
  const cap = makeRes();
  await api.handleApiRequest(req, cap.res, ctx);
  return cap;
}

/** The gateway's own top-level agent session: the COO the operator talks to. */
function portalSession(ref: string): string {
  return reg.createSession({ engine: "codex", source: "web", sourceRef: ref }).id;
}
/** The employee-less session anyone CAN mint: parented, therefore not the portal. */
function childSession(ref: string): string {
  return reg.createSession({ engine: "codex", source: "web", sourceRef: ref, parentSessionId: portalSession(`${ref}-parent`) }).id;
}
function employeeSession(ref: string): string {
  return reg.createSession({ engine: "codex", source: "web", sourceRef: ref, employee: "platform-worker" }).id;
}

/** trigger → gate → end, so the run parks on the gate with no attempt to run. */
function gateDefinition(id: string, config: Record<string, unknown>): WorkflowDefinition {
  const created = repository.createDefinition({ id, title: id });
  const nodes: WorkflowNode[] = [
    { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
    { id: "gate", type: "approval", name: "Gate", config: { description: "Land it?", ...config } } as WorkflowNode,
    { id: "landed", type: "end", name: "Landed", config: { result: "success" } },
    { id: "stopped", type: "end", name: "Stopped", config: { result: "success" } },
  ];
  const saved = repository.saveDefinition({ ...created, inputs: [], nodes, edges: [
    { id: "start-gate", from: { nodeId: "start", port: "success" }, to: { nodeId: "gate", port: "input" } },
    { id: "gate-landed", from: { nodeId: "gate", port: "approved" }, to: { nodeId: "landed", port: "input" } },
    { id: "gate-stopped", from: { nodeId: "gate", port: "rejected" }, to: { nodeId: "stopped", port: "input" } },
  ] }, created.revision);
  return repository.setEnabled(saved.id, true, saved.revision);
}

async function parkedRun(definitionId: string): Promise<{ runId: string; revision: number }> {
  const run = await service.startManual({ workflowId: definitionId, input: {} });
  return { runId: run.id, revision: service.getRun(definitionId, run.id)!.revision };
}

function approvalRoute(definitionId: string, runId: string): string {
  return `/api/workflows/${definitionId}/runs/${runId}/nodes/gate/approval`;
}

/** A Todo carrying the mirrored gate, the way a parked run leaves one. */
function mirroredTodo(title: string, definitionId: string, runId: string): string {
  const item = store.createWorkItem({ title, status: "in_review", assignee: "platform-worker", department: "platform" });
  approvals.requestApproval(item.id, { request: "Land it?", ref: `workflow:${definitionId}:${runId}:gate`, actor: "workflow" });
  return item.id;
}

beforeAll(async () => {
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  approvals = await import("../../work-items/approvals.js");
  (await import("../../shared/db.js")).initDb();

  const { openWorkflowDatabase } = await import("../../workflows/repository-migrations.js");
  const { WorkflowRepository } = await import("../../workflows/repository.js");
  const { WorkflowService } = await import("../../workflows/service.js");
  database = openWorkflowDatabase(path.join(tmp, "workflows.db"));
  repository = new WorkflowRepository(database);
  service = new WorkflowService({
    repository,
    // Nothing here ever reaches an Employee node: every run parks on its gate.
    executor: {
      async startAttempt() { return { sessionId: "unused" }; },
      async stopAttempt() {},
      subscribe() { return () => {}; },
      readTerminalCompletion() { return null; },
    } as unknown as WorkflowSessionExecutor,
    employees: () => new Map(),
    models: () => ({}),
  });
  ctx = {
    getConfig: () => ({ gateway: {}, engines: {}, sessions: {} }),
    connectors: new Map(),
    startTime: Date.now(),
    gatewayAuthToken: "test-token",
    emit: () => undefined,
    workflowService: service,
    sessionManager: { getEngines: () => new Map(), getQueue: () => ({}) },
  } as unknown as import("../api.js").ApiContext;
});

afterAll(() => {
  service.dispose();
  database.close();
});

describe("a workflow gate the definition hands to the COO", () => {
  it("lets the portal session decide it, and credits that session", async () => {
    const definition = gateDefinition("coo-land", { decidableBy: "coo" });
    const { runId, revision } = await parkedRun(definition.id);
    const coo = portalSession("web:coo-decides-workflow-gate");

    const cap = await post(approvalRoute(definition.id, runId), { decision: "approve", expectedRevision: revision }, toolHeaders(coo));

    expect(cap.status).toBe(200);
    expect(service.getRun(definition.id, runId)!.approvals[0]).toMatchObject({ status: "approved", decidedBy: `session:${coo}` });
  });

  it("refuses an employee session", async () => {
    const definition = gateDefinition("coo-land-employee", { decidableBy: "coo" });
    const { runId, revision } = await parkedRun(definition.id);

    const cap = await post(approvalRoute(definition.id, runId), { decision: "approve", expectedRevision: revision },
      toolHeaders(employeeSession("web:employee-decides-coo-gate")));

    expect([cap.status, cap.body.message]).toEqual([403,
      "Workflow approval gate is COO-decidable; platform-worker cannot decide it."]);
    expect(service.getRun(definition.id, runId)!.approvals[0]!.status).toBe("pending");
  });

  it("refuses the employee-less child anyone can mint — a child is not the portal", async () => {
    const definition = gateDefinition("coo-land-child", { decidableBy: "coo" });
    const { runId, revision } = await parkedRun(definition.id);
    const child = childSession("web:child-decides-coo-gate");

    const cap = await post(approvalRoute(definition.id, runId), { decision: "approve", expectedRevision: revision }, toolHeaders(child));

    expect([cap.status, cap.body.message]).toEqual([403,
      `Workflow approval gate is COO-decidable; session:${child} cannot decide it.`]);
    expect(service.getRun(definition.id, runId)!.approvals[0]!.status).toBe("pending");
  });

  it("refuses a caller who merely names the portal session without its capability", async () => {
    const definition = gateDefinition("coo-land-spoof", { decidableBy: "coo" });
    const { runId, revision } = await parkedRun(definition.id);
    const coo = portalSession("web:coo-spoof-target");

    const cap = await post(approvalRoute(definition.id, runId), { decision: "approve", expectedRevision: revision },
      { authorization: "Bearer test-token", [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE, [CALLER_SESSION_HEADER]: coo });

    expect(cap.status).toBe(403);
    expect(service.getRun(definition.id, runId)!.approvals[0]!.status).toBe("pending");
  });
});

describe("a workflow gate the operator reserved stays reserved", () => {
  it("refuses the portal session, in the words that surface already uses", async () => {
    const definition = gateDefinition("operator-land", { operatorOnly: true });
    const { runId, revision } = await parkedRun(definition.id);
    const coo = portalSession("web:coo-decides-operator-gate");

    const cap = await post(approvalRoute(definition.id, runId), { decision: "approve", expectedRevision: revision }, toolHeaders(coo));

    expect([cap.status, cap.body.message]).toEqual([403,
      `Workflow approval gate is operator-only; session:${coo} cannot decide it.`]);
    expect(service.getRun(definition.id, runId)!.approvals[0]!.status).toBe("pending");
  });

  it("refuses an employee session too", async () => {
    const definition = gateDefinition("operator-land-employee", { operatorOnly: true });
    const { runId, revision } = await parkedRun(definition.id);

    const cap = await post(approvalRoute(definition.id, runId), { decision: "approve", expectedRevision: revision },
      toolHeaders(employeeSession("web:employee-decides-operator-gate")));

    expect([cap.status, cap.body.message]).toEqual([403,
      "Workflow approval gate is operator-only; platform-worker cannot decide it."]);
  });
});

/* The Todo side of the same gate. Deciding and escalating read one reservation,
 * so escalating can never open a path that deciding refuses. */
describe("the Todo surfaces mirroring a COO gate", () => {
  it("lets the portal session decide it and refuses the employee-less child", async () => {
    const definition = gateDefinition("coo-todo-decide", { decidableBy: "coo" });
    const { runId } = await parkedRun(definition.id);
    const child = childSession("web:child-decides-mirrored-gate");

    const refused = await post(`/api/work-items/${mirroredTodo("Mirrored gate, child", definition.id, runId)}/approval`,
      { decision: "approve" }, toolHeaders(child));
    expect([refused.status, refused.body.error]).toEqual([403,
      `session ${child} has no employee identity; approval decisions require manager/COO authority`]);

    const todoId = mirroredTodo("Mirrored gate, COO", definition.id, runId);
    const coo = portalSession("web:coo-decides-mirrored-gate");
    const decided = await post(`/api/work-items/${todoId}/approval`, { decision: "approve" }, toolHeaders(coo));

    expect(decided.status).toBe(200);
    expect(store.getWorkItem(todoId)?.approvalDecidedBy).toBe(`session:${coo}`);
  });

  it("gives escalation the same answer as deciding", async () => {
    const definition = gateDefinition("coo-todo-escalate", { decidableBy: "coo" });
    const { runId } = await parkedRun(definition.id);
    const child = childSession("web:child-escalates-mirrored-gate");

    const refused = await post(`/api/work-items/${mirroredTodo("Mirrored gate, child escalates", definition.id, runId)}/approval/escalate`,
      {}, toolHeaders(child));
    expect([refused.status, refused.body.error]).toEqual([403,
      `session ${child} has no employee identity; approval decisions require manager/COO authority`]);

    const todoId = mirroredTodo("Mirrored gate, COO escalates", definition.id, runId);
    const escalated = await post(`/api/work-items/${todoId}/approval/escalate`, {},
      toolHeaders(portalSession("web:coo-escalates-mirrored-gate")));

    expect(escalated.status).toBe(200);
    expect(store.getWorkItem(todoId)?.approvalEscalatedAt).toBeTruthy();
  });
});
