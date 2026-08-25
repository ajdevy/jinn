import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkflowDefinition, WorkflowNode } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";
import type { WorkflowTodoApprovalMirror } from "../runner.js";

/* The second reserved gate class. `operatorOnly` is the reservation AND the
 * token that lets an approved run close its bound Todo, so a gate the COO may
 * decide had to become its own class rather than that flag dropped. */

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let service: WorkflowService;
/** What the runner hands the Todo mirror when a gate parks. */
const parked: Array<Parameters<WorkflowTodoApprovalMirror["notifyParked"]>[0]> = [];

/** These workflows park on the Approval before any Employee node, so the
 *  executor only has to exist. */
function idleExecutor(): WorkflowSessionExecutor {
  return {
    async startAttempt() { return { sessionId: "unused" }; },
    async stopAttempt() {},
    subscribe() { return () => {}; },
    readTerminalCompletion() { return null; },
  } as unknown as WorkflowSessionExecutor;
}

function gateDefinition(id: string, config: Record<string, unknown>): WorkflowDefinition {
  const created = repository.createDefinition({ id, title: id });
  const nodes: WorkflowNode[] = [
    { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
    { id: "review", type: "approval", name: "Review", config } as WorkflowNode,
    { id: "accepted", type: "end", name: "Accepted", config: { result: "success" } },
    { id: "declined", type: "end", name: "Declined", config: { result: "success" } },
  ];
  const saved = repository.saveDefinition({ ...created, inputs: [], nodes, edges: [
    { id: "start-review", from: { nodeId: "start", port: "success" }, to: { nodeId: "review", port: "input" } },
    { id: "review-approved", from: { nodeId: "review", port: "approved" }, to: { nodeId: "accepted", port: "input" } },
    { id: "review-rejected", from: { nodeId: "review", port: "rejected" }, to: { nodeId: "declined", port: "input" } },
  ] }, created.revision);
  return repository.setEnabled(saved.id, true, saved.revision);
}

/** The validation issues a definition the schema refuses comes back with. */
function refusalIssues(id: string, config: Record<string, unknown>): unknown {
  let issues: unknown;
  expect(() => {
    try {
      gateDefinition(id, config);
    } catch (error) {
      issues = (error as { issues?: unknown }).issues;
      throw error;
    }
  }).toThrow(/Workflow definition is invalid/i);
  return issues;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-coo-gate-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database);
  parked.length = 0;
  service = new WorkflowService({
    repository, executor: idleExecutor(), employees: () => new Map(), models: () => ({}),
    todoApprovals: { request: () => {}, notifyParked: (input) => { parked.push(input); } },
  });
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("what the definition schema makes of a COO-decidable gate", () => {
  it("accepts it on its own", () => {
    const definition = gateDefinition("coo-gate-parses", { description: "Land it?", decidableBy: "coo" });

    expect(definition.nodes.find((node) => node.id === "review"))
      .toMatchObject({ type: "approval", config: { decidableBy: "coo" } });
  });

  it("refuses it alongside operator-only, naming why", () => {
    expect(refusalIssues("coo-and-operator", { description: "Land it?", decidableBy: "coo", operatorOnly: true }))
      .toContainEqual(expect.objectContaining({
        message: "A COO-decidable approval cannot also be operator-only or name an approver.",
      }));
  });

  it("refuses it alongside a named approver, naming why", () => {
    expect(refusalIssues("coo-and-approver", {
      description: "Land it?", decidableBy: "coo", approver: { source: "fixed", value: "worker" },
    })).toContainEqual(expect.objectContaining({
      message: "A COO-decidable approval cannot also be operator-only or name an approver.",
    }));
  });
});

describe("who the service lets decide a COO-decidable gate", () => {
  it("refuses a decider the gateway did not look up as the COO or the operator", async () => {
    const definition = gateDefinition("coo-gate-employee", { description: "Land it?", decidableBy: "coo" });
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-14" });

    // An omitted authority is a caller that never resolved one: refused, not assumed.
    for (const authority of ["employee", undefined] as const) {
      await expect(service.decideApproval({ workflowId: definition.id, runId: run.id, nodeId: "review",
        decision: "approve", decidedBy: "session:not-the-portal", expectedRevision: run.revision,
        ...(authority ? { decidedByAuthority: authority } : {}) }))
        .rejects.toThrow("Workflow approval review is COO-decidable; session:not-the-portal cannot decide it.");
    }

    expect(service.getRun(definition.id, run.id)!.approvals[0]!.status).toBe("pending");
  });

  it("lets the COO decide it and the run advances", async () => {
    const definition = gateDefinition("coo-gate-decided", { description: "Land it?", decidableBy: "coo" });
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-15" });

    const decided = await service.decideApproval({ workflowId: definition.id, runId: run.id, nodeId: "review",
      decision: "approve", decidedBy: "session:portal", decidedByAuthority: "coo", expectedRevision: run.revision });

    expect(decided.status).toBe("completed");
  });

  it("still refuses the COO an operator-only gate, in the words that surface already uses", async () => {
    const definition = gateDefinition("operator-gate-vs-coo", { description: "Merge to main?", operatorOnly: true });
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-16" });

    await expect(service.decideApproval({ workflowId: definition.id, runId: run.id, nodeId: "review",
      decision: "approve", decidedBy: "session:portal", decidedByAuthority: "coo", expectedRevision: run.revision }))
      .rejects.toThrow("Workflow approval review is operator-only; session:portal cannot decide it.");
  });
});

describe("what the runner tells the Todo mirror about the gate class", () => {
  // Default Todo routing hands an unrouted gate to the owner's manager. Without
  // the class the mirror wakes that manager with "waiting on YOUR decision",
  // which both the Todo decide and escalate routes then refuse with a 403.
  it("marks a COO-decidable gate, and leaves an ordinary routed one unmarked", async () => {
    const coo = gateDefinition("coo-gate-mirrored", { description: "Land it?", decidableBy: "coo" });
    await service.startManual({ workflowId: coo.id, input: {}, todoId: "OPS-17" });
    expect(parked[0]).toMatchObject({ todoId: "OPS-17", cooDecidable: true });

    const routed = gateDefinition("routed-gate-mirrored", { description: "Approve?" });
    await service.startManual({ workflowId: routed.id, input: {}, todoId: "OPS-18" });
    expect(parked[1]).toMatchObject({ todoId: "OPS-18", cooDecidable: false });
  });
});
