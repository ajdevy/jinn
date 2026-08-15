import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Employee, ModelRegistry } from "../../shared/types.js";
import type { TriggerNode, WorkflowDefinition, WorkflowNode } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";
import { parseTodoApprovalRef } from "../todo-approval-ref.js";

/* The whole loop a Todo-bound gate travels, with nothing faked between its ends:
 * the run parks and mirrors the gate onto its Todo, the Workflow-side HTTP door
 * REFUSES that gate, the Todo door decides it, the decision listener resumes the
 * run, and the reconciler closes the Todo. Two halves that each pass on their own
 * still stranded the Todo forever, so the closing loop is asserted end to end.
 *
 * The Workflow-side refusal is the regression assertion: before the guard in
 * gateway/workflow-api.ts, that door answered 200 and settled the run's own
 * approval row while the Todo's pending row stayed pending for good. */

// The registry DB resolves from JINN_HOME at module load, so it is pointed at a
// throwaway home before the work-item and gateway modules are imported.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-todo-approval-loop-"));
process.env.JINN_HOME = home;

type Store = typeof import("../../work-items/store.js");
type Approvals = typeof import("../../work-items/approvals.js");
type Rows = typeof import("../../work-items/approval-rows.js");
type Reconcile = typeof import("../../work-items/reconcile.js");
type Surface = typeof import("../../gateway/workflow-todo-surface.js");
type Door = typeof import("../../gateway/workflow-api.js");
let store: Store;
let approvals: Approvals;
let rows: Rows;
let reconcile: Reconcile;
let surface: Surface;
let door: Door;

const employee: Employee = {
  name: "worker", displayName: "Worker", department: "operations", rank: "employee",
  engine: "test-engine", model: "test-model", effortLevel: "high", persona: "Complete the task.",
};
const models: ModelRegistry = {
  "test-engine": {
    name: "test-engine", available: true, defaultModel: "test-model", effortMechanism: "codex-config",
    models: [{ id: "test-model", label: "Test", supportsEffort: true, effortLevels: ["high"] }],
  },
};

/** These workflows park on the gate before any Employee node, so the executor
 *  only has to exist. */
function idleExecutor(): WorkflowSessionExecutor {
  return {
    async startAttempt() { return { sessionId: "unused" }; },
    async stopAttempt() {},
    subscribe() { return () => {}; },
    readTerminalCompletion() { return null; },
  } as unknown as WorkflowSessionExecutor;
}

/** The gateway's own fake req/res pair, so the refusal is read off the real
 *  route rather than off a stub of it. */
function request(method: string, url: string, body: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: { host: "localhost", "content-type": "application/json" } });
  return req as unknown as Parameters<Door["handleWorkflowApi"]>[0];
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
  return { res, read: () => ({ status, body: chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as { code?: string; message?: string }
    : undefined }) };
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let service: WorkflowService;
/** The mirror-back is fire-and-forget in the gateway; the handle is kept only so
 *  a test can await the resume instead of racing it. */
let mirrorBack: Promise<unknown> = Promise.resolve();
let seq = 0;

function edge(id: string, from: string, port: string, to: string) {
  return { id, from: { nodeId: from, port }, to: { nodeId: to, port: "input" as const } };
}

/** trigger → gate → end, with the gate's `rejected` port routed to its own End. */
function gatePipeline(id: string, trigger: TriggerNode["config"] = { kind: "manual" }): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: "start", type: "trigger", name: "Start", config: trigger },
    { id: "gate", type: "approval", name: "Gate", config: { description: "Ship this batch?" } },
    { id: "shipped", type: "end", name: "Shipped", config: { result: "success" } },
    { id: "held", type: "end", name: "Held", config: { result: "failure" } },
  ];
  const created = service.createDefinition({ id, title: id });
  const saved = service.saveDefinition({ ...created, inputs: [], nodes, edges: [
    edge("start-gate", "start", "success", "gate"),
    edge("gate-shipped", "gate", "approved", "shipped"),
    edge("gate-held", "gate", "rejected", "held"),
  ] }, created.revision);
  return service.setEnabled({ id: saved.id, enabled: true, expectedRevision: saved.revision });
}

/** A trust-tier Todo the reconciler is licensed to close, plus a run bound to it,
 *  parked on the mirrored gate. */
async function boundRunParkedOnGate(trigger?: TriggerNode["config"]) {
  seq += 1;
  const todoId = store.createWorkItem({
    title: `Batch ${seq}`, source: "human", verifyPolicy: { mode: "trust" },
  }).id;
  const definition = gatePipeline(`loop-${seq}`, trigger);
  const run = await service.startManual({ workflowId: definition.id, input: {}, todoId });
  return { todoId, workflowId: definition.id, runId: run.id };
}

function runStatus(workflowId: string, runId: string) {
  return service.getRun(workflowId, runId)!;
}

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  approvals = await import("../../work-items/approvals.js");
  rows = await import("../../work-items/approval-rows.js");
  reconcile = await import("../../work-items/reconcile.js");
  surface = await import("../../gateway/workflow-todo-surface.js");
  door = await import("../../gateway/workflow-api.js");
  (await import("../../shared/db.js")).initDb();

  // The one loop-closer, wired exactly as the gateway wires it: a gate decided on
  // the Todo resolves the workflow node that mirrored it, carrying the pick.
  approvals.setTodoApprovalDecisionListener(({ approval, decision, decidedBy }) => {
    const origin = parseTodoApprovalRef(approval.ref);
    if (!origin) return;
    const run = repository.getRun(origin.workflowId, origin.runId);
    if (!run) return;
    mirrorBack = service.decideApproval({ ...origin, decision, decidedBy, expectedRevision: run.revision,
      ...(approval.choice ? { choice: approval.choice } : {}),
      ...(approval.note ? { reason: approval.note } : {}) });
  });
});

afterAll(() => {
  approvals.setTodoApprovalDecisionListener(null);
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-approval-loop-runs-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database);
  mirrorBack = Promise.resolve();
  service = new WorkflowService({
    repository, executor: idleExecutor(),
    employees: () => new Map([[employee.name, employee]]), models: () => models,
    now: () => "2026-07-30T10:00:00.000Z",
    todoApprovals: surface.workflowTodoApprovals(({ todoId, request: gate, ref, options, approver }) => {
      approvals.requestApproval(todoId, { request: gate, ref, ...(options ? { options } : {}),
        ...(approver ? { target: approver } : {}), actor: "workflow" });
    }),
    todoLifecycle: surface.workflowTodoLifecycle,
  });
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a Todo-bound gate decided on its Todo closes the loop", () => {
  it("refuses the Workflow-side door, clears the Todo's row, resumes the run, and trust-closes the Todo", async () => {
    const { todoId, workflowId, runId } = await boundRunParkedOnGate();

    // (a) parked, and mirrored onto the Todo where it can be decided.
    expect(runStatus(workflowId, runId).status).toBe("waiting");
    expect(rows.currentApproval(todoId)).toMatchObject({ state: "pending" });

    // (b) THE REGRESSION ASSERTION. The Workflow-side door is closed for a bound
    // run: deciding there would settle the run's own row and leave the Todo's
    // pending forever. MCP, the CLI and the web run page are thin projections of
    // this one route, so the refusal reaches all of them.
    const refused = response();
    await door.handleWorkflowApi(
      request("POST", `/api/workflows/${workflowId}/runs/${runId}/nodes/gate/approval`,
        { decision: "approve", expectedRevision: runStatus(workflowId, runId).revision }),
      refused.res, { service, authenticated: true },
    );
    expect(refused.read().status).toBe(403);
    expect(refused.read().body?.code).toBe("forbidden");
    expect(refused.read().body?.message).toContain("decide_work_item_approval");
    expect(refused.read().body?.message).toContain(todoId);
    // Refused means untouched: both rows are exactly as the park left them.
    expect(runStatus(workflowId, runId).approvals[0]!.status).toBe("pending");
    expect(rows.currentApproval(todoId)).toMatchObject({ state: "pending" });

    // (c) the Todo door decides it, and the pending row resolves.
    const decided = await approvals.decideWorkItemApproval({ id: todoId, decision: "approve",
      decidedBy: "operator" });
    expect(decided.ok).toBe(true);
    expect(rows.currentApproval(todoId)?.state).not.toBe("pending");

    // (d) the listener carried the decision back and the run ran to its End.
    await mirrorBack;
    const resumed = runStatus(workflowId, runId);
    expect(resumed.status).toBe("completed");
    expect(resumed.approvals[0]!.status).toBe("approved");

    // (e) with no gate pending, the trust tier closes the bound Todo in one sweep.
    expect(store.getWorkItem(todoId)!.status).toBe("in_review");
    reconcile.reconcileWorkItem(todoId);
    expect(store.getWorkItem(todoId)!.status).toBe("done");
  });

  it("sends the Todo round again when the gate is rejected with feedback", async () => {
    // The re-arm target is read off the CURRENT definition, so the pipeline gains
    // its Todo trigger while the run is parked; the run itself started manually.
    const { todoId, workflowId, runId } = await boundRunParkedOnGate();
    const current = service.getDefinition(workflowId)!;
    service.saveDefinition({ ...current, nodes: current.nodes.map((node): WorkflowNode => node.id === "start"
      ? { id: "start", type: "trigger", name: "Start", config: { kind: "todo-status", status: "assigned" } }
      : node) }, current.revision);

    const decided = await approvals.decideWorkItemApproval({ id: todoId, decision: "reject",
      decidedBy: "operator", note: "The empty state still reads as an error." });
    expect(decided.ok).toBe(true);
    await mirrorBack;

    // Cancelled, not failed: a human stopped this on purpose, and a failed run
    // would reflect `blocked` onto the very Todo being re-armed.
    const stopped = runStatus(workflowId, runId);
    expect(stopped.status).toBe("cancelled");
    expect(stopped.error?.code).toBe("workflow-revision-requested");

    // Re-armed at the status its own trigger fires on, carrying the feedback.
    expect(store.getWorkItem(todoId)!.status).toBe("assigned");
    expect(rows.currentApproval(todoId)?.state).toBe("rejected");
  });
});

describe("the same door on an unbound run", () => {
  it("decides the gate and advances the run exactly as before", async () => {
    // The refusal must not over-reach: with no Todo to park on, this door is
    // still the only place the gate can be decided.
    seq += 1;
    const definition = gatePipeline(`unbound-${seq}`);
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    expect(run.trigger.todoId).toBeUndefined();
    expect(runStatus(definition.id, run.id).approvals[0]!.status).toBe("pending");

    const decided = response();
    await door.handleWorkflowApi(
      request("POST", `/api/workflows/${definition.id}/runs/${run.id}/nodes/gate/approval`,
        { decision: "approve", expectedRevision: run.revision }),
      decided.res, { service, authenticated: true },
    );

    expect(decided.read().status).toBe(200);
    expect(runStatus(definition.id, run.id).status).toBe("completed");
    expect(runStatus(definition.id, run.id).approvals[0]!.status).toBe("approved");
  });
});
