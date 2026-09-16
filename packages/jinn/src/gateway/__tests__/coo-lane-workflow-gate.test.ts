import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkflowDefinition, WorkflowNode } from "../../workflows/model.js";
import type { WorkflowSessionExecutor } from "../../workflows/session-executor.js";
import {
  COO_GATE_HOME, makeRes, requestOf, spoofPortalHeaders, toolHeaders,
} from "./coo-lane-gate-harness.js";

/**
 * A land gate the COO may decide, and the three sessions that may not.
 *
 * `operatorOnly` is also the Todo-close token, so the COO's authority is a
 * second class rather than that flag dropped. Safety is the whole portal
 * shape — no employee, no PARENT, no workflow provenance — which no session
 * an employee can mint ever has.
 */

type Api = typeof import("../api.js");
type WorkflowApi = typeof import("../workflow-api.js");
type Reg = typeof import("../../sessions/registry.js");
type Store = typeof import("../../work-items/store.js");
type Approvals = typeof import("../../work-items/approvals.js");
let api: Api;
let handleWorkflowApi: WorkflowApi["handleWorkflowApi"];
let reg: Reg;
let store: Store;
let approvals: Approvals;
let database: Database.Database;
let repository: import("../../workflows/repository.js").WorkflowRepository;
let service: import("../../workflows/service.js").WorkflowService;
let ctx: import("../api.js").ApiContext;

async function post(urlPath: string, body: Record<string, unknown>, headers: Record<string, string>) {
  const cap = makeRes();
  await api.handleApiRequest(requestOf(urlPath, body, headers) as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, ctx);
  return cap;
}

/** The workflow handler itself, past the outer unidentified-tool 403. */
async function postWorkflow(urlPath: string, body: Record<string, unknown>, headers: Record<string, string>) {
  const cap = makeRes();
  const url = new URL(urlPath, "http://localhost");
  await handleWorkflowApi(
    requestOf(urlPath, body, headers) as unknown as Parameters<WorkflowApi["handleWorkflowApi"]>[0],
    cap.res, { method: "POST", pathname: url.pathname, url }, { service, authenticated: true },
  );
  return cap;
}

function portalSession(ref: string): string {
  return reg.createSession({ engine: "codex", source: "web", sourceRef: ref }).id;
}
function childSession(ref: string): string {
  return reg.createSession({ engine: "codex", source: "web", sourceRef: ref, parentSessionId: portalSession(`${ref}-parent`) }).id;
}
function employeeSession(ref: string, employee = "platform-worker"): string {
  return reg.createSession({ engine: "codex", source: "web", sourceRef: ref, employee }).id;
}

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

function mirroredTodo(title: string, definitionId: string, runId: string): string {
  const item = store.createWorkItem({ title, status: "in_review", assignee: "platform-worker", department: "platform" });
  approvals.requestApproval(item.id, { request: "Land it?", ref: `workflow:${definitionId}:${runId}:gate`, actor: "workflow" });
  return item.id;
}

beforeAll(async () => {
  api = await import("../api.js");
  handleWorkflowApi = (await import("../workflow-api.js")).handleWorkflowApi;
  reg = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  approvals = await import("../../work-items/approvals.js");
  (await import("../../shared/db.js")).initDb();

  const { openWorkflowDatabase } = await import("../../workflows/repository-migrations.js");
  const { WorkflowRepository } = await import("../../workflows/repository.js");
  const { WorkflowService } = await import("../../workflows/service.js");
  database = openWorkflowDatabase(path.join(COO_GATE_HOME, "workflows.db"));
  repository = new WorkflowRepository(database);
  service = new WorkflowService({
    repository,
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

  it("refuses a caller who merely names the portal session in the unverified actor header", async () => {
    const definition = gateDefinition("coo-land-spoof", { decidableBy: "coo" });
    const { runId, revision } = await parkedRun(definition.id);
    const coo = portalSession("web:coo-spoof-target");
    const body = { decision: "approve" as const, expectedRevision: revision };

    await expect(service.decideApproval({
      workflowId: definition.id, runId, nodeId: "gate", ...body,
      decidedBy: `session:${coo}`, decidedByAuthority: "employee",
    })).rejects.toThrow(`Workflow approval gate is COO-decidable; session:${coo} cannot decide it.`);

    const cap = await postWorkflow(approvalRoute(definition.id, runId), body, spoofPortalHeaders(coo));
    expect([cap.status, cap.body.message]).toEqual([403,
      `Workflow approval gate is COO-decidable; session:${coo} cannot decide it.`]);
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

describe("the Todo surfaces mirroring a COO gate", () => {
  it("lets the portal session decide it and refuses the employee-less child", async () => {
    const definition = gateDefinition("coo-todo-decide", { decidableBy: "coo" });
    const { runId } = await parkedRun(definition.id);
    const child = childSession("web:child-decides-mirrored-gate");
    const childTodo = mirroredTodo("Mirrored gate, child", definition.id, runId);

    const refused = await post(`/api/work-items/${childTodo}/approval`,
      { decision: "approve" }, toolHeaders(child));
    expect([refused.status, refused.body.error]).toEqual([403,
      `Todo ${childTodo} has a COO-decidable approval; only the COO portal session may decide it`]);

    const todoId = mirroredTodo("Mirrored gate, COO", definition.id, runId);
    const coo = portalSession("web:coo-decides-mirrored-gate");
    const decided = await post(`/api/work-items/${todoId}/approval`, { decision: "approve" }, toolHeaders(coo));

    expect(decided.status).toBe(200);
    expect(store.getWorkItem(todoId)?.approvalDecidedBy).toBe(`session:${coo}`);
  });

  it("gives escalation the same answer as deciding — a routed manager is refused both", async () => {
    const definition = gateDefinition("coo-todo-escalate", { decidableBy: "coo" });
    const { runId } = await parkedRun(definition.id);
    const manager = employeeSession("web:manager-on-mirrored-gate", "platform-manager");
    const decideTodo = mirroredTodo("Mirrored gate, manager decides", definition.id, runId);
    const escalateTodo = mirroredTodo("Mirrored gate, manager escalates", definition.id, runId);
    const refusal = (id: string) =>
      `Todo ${id} has a COO-decidable approval; only the COO portal session may decide it`;

    const decided = await post(`/api/work-items/${decideTodo}/approval`, { decision: "approve" }, toolHeaders(manager));
    const escalated = await post(`/api/work-items/${escalateTodo}/approval/escalate`, {}, toolHeaders(manager));
    expect([decided.status, decided.body.error]).toEqual([403, refusal(decideTodo)]);
    expect([escalated.status, escalated.body.error]).toEqual([403, refusal(escalateTodo)]);

    const todoId = mirroredTodo("Mirrored gate, COO escalates", definition.id, runId);
    const allowed = await post(`/api/work-items/${todoId}/approval/escalate`, {},
      toolHeaders(portalSession("web:coo-escalates-mirrored-gate")));

    expect(allowed.status).toBe(200);
    expect(store.getWorkItem(todoId)?.approvalEscalatedAt).toBeTruthy();
  });
});
