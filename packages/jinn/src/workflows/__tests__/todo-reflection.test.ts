import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Employee,
  ModelRegistry,
  WorkflowAttemptCommand,
  WorkflowAttemptCompletion,
  WorkflowAttemptCompletionListener,
} from "../../shared/types.js";
import { TransitionError } from "../../work-items/transitions.js";
import type { JsonValue, WorkflowDefinition, WorkflowNode } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";
import type { WorkflowRevisionRequest, WorkflowTodoApprovalMirror, WorkflowTodoLifecycle } from "../runner.js";

/* A Todo-bound run reports its own lifecycle onto that Todo. Before this, the only
 * reason a bound Todo ever moved was a workflow author hand-writing
 * `update_work_item` into every phase prompt and wiring a record-failure branch
 * into the graph — so one forgotten instruction left a merged Todo reading
 * `assigned`, and a parked gate told nobody for eleven hours. */

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

class FakeExecutor {
  readonly commands: WorkflowAttemptCommand[] = [];
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();

  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    this.commands.push(command);
    return { sessionId: `session:${command.owner.nodeId}:${command.owner.attempt}` };
  }
  async stopAttempt(): Promise<void> {}
  subscribe(listener: WorkflowAttemptCompletionListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  readTerminalCompletion(): WorkflowAttemptCompletion | null { return null; }
  attemptState(): { idle: boolean; runningChildren: number } { return { idle: true, runningChildren: 0 }; }

  async succeed(nodeId: string, fields: Record<string, JsonValue> = {}): Promise<void> {
    await this.emit(nodeId, { outcome: "succeeded", finalText: `Done.\n\`\`\`jinn-output\n${JSON.stringify(fields)}\n\`\`\`` });
  }
  async failTurn(nodeId: string, error: string): Promise<void> {
    await this.emit(nodeId, { outcome: "failed", error });
  }
  private async emit(nodeId: string, outcome: Partial<WorkflowAttemptCompletion>): Promise<void> {
    const command = this.commands.filter((item) => item.owner.nodeId === nodeId).at(-1)!;
    await Promise.all([...this.listeners].map((listener) => listener({
      sessionId: `session:${nodeId}:${command.owner.attempt}`, owner: command.owner,
      terminalVersion: 1, turn: 1, completedAt: now.toISOString(), outcome: "succeeded", ...outcome,
    } as WorkflowAttemptCompletion)));
  }
}

class RecordingLifecycle implements WorkflowTodoLifecycle {
  readonly reflections: Array<{ todoId: string; status: string; nodeId: string }> = [];
  readonly failures: Array<{ todoId: string; nodeId: string; runId: string; code: string; message: string }> = [];
  readonly revisions: WorkflowRevisionRequest[] = [];
  readonly decisions: Array<Parameters<WorkflowTodoLifecycle["recordApprovalDecision"]>[0]> = [];
  readonly completions: Array<Parameters<WorkflowTodoLifecycle["complete"]>[0]> = [];
  reflect(input: Parameters<WorkflowTodoLifecycle["reflect"]>[0]): void {
    this.reflections.push({ todoId: input.todoId, status: input.status, nodeId: input.nodeId });
  }
  recordFailure(input: Parameters<WorkflowTodoLifecycle["recordFailure"]>[0]): void {
    this.failures.push({ todoId: input.todoId, nodeId: input.nodeId, runId: input.runId,
      code: input.error.code, message: input.error.message });
  }
  requestRevision(input: WorkflowRevisionRequest): void {
    this.revisions.push(input);
  }
  recordApprovalDecision(input: typeof this.decisions[number]): void {
    this.decisions.push(input);
  }
  complete(input: typeof this.completions[number]): void {
    this.completions.push(input);
  }
}

class RecordingMirror implements WorkflowTodoApprovalMirror {
  readonly requests: Array<Parameters<WorkflowTodoApprovalMirror["request"]>[0]> = [];
  readonly parked: Array<{ todoId: string; nodeId: string; request: string; ref: string }> = [];
  request(input: Parameters<WorkflowTodoApprovalMirror["request"]>[0]): void { this.requests.push(input); }
  notifyParked(input: Parameters<WorkflowTodoApprovalMirror["notifyParked"]>[0]): void {
    this.parked.push({ todoId: input.todoId, nodeId: input.nodeId, request: input.request, ref: input.ref });
  }
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: FakeExecutor;
let lifecycle: RecordingLifecycle;
let mirror: RecordingMirror;
let service: WorkflowService;
const now = new Date("2026-07-30T10:00:00.000Z");

function edge(id: string, from: string, port: string, to: string) {
  return { id, from: { nodeId: from, port }, to: { nodeId: to, port: "input" as const } };
}
function worker(id: string): WorkflowNode {
  return {
    id, type: "employee", name: id, config: {
      employee: { source: "fixed", value: "worker" }, prompt: `Run ${id}.`,
      output: { fields: {}, allowAdditionalFields: true },
    },
  };
}
/** Decide a parked gate at the run's current revision. */
async function decide(definition: WorkflowDefinition, runId: string, nodeId: string, decision: "approve" | "reject",
  opts: { reason?: string; decidedBy?: string; choice?: string } = {}) {
  return service.decideApproval({ workflowId: definition.id, runId, nodeId, decision,
    decidedBy: opts.decidedBy ?? "operator", ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    ...(opts.choice !== undefined ? { choice: opts.choice } : {}),
    expectedRevision: service.getRun(definition.id, runId)!.revision });
}
function save(id: string, nodes: WorkflowNode[], edges: ReturnType<typeof edge>[]): WorkflowDefinition {
  const created = repository.createDefinition({ id, title: id });
  const saved = repository.saveDefinition({ ...created, inputs: [], nodes, edges }, created.revision);
  return repository.setEnabled(saved.id, true, saved.revision);
}

/** trigger → plan → gate → land → end: two phases around a parked approval. */
function gatedPipeline(id: string, gate: { operatorOnly?: boolean; options?: string[] } = {}): WorkflowDefinition {
  return save(id, [
    { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
    worker("plan"),
    { id: "gate", type: "approval", name: "Gate", config: {
      description: "Approving merges this branch into main.", ...gate,
    } },
    worker("land"),
    { id: "done", type: "end", name: "Done", config: { result: "success" } },
    { id: "not-merged", type: "end", name: "Not merged", config: { result: "failure" } },
  ], [
    edge("start-plan", "start", "success", "plan"),
    edge("plan-gate", "plan", "success", "gate"),
    edge("gate-land", "gate", "approved", "land"),
    edge("gate-stop", "gate", "rejected", "not-merged"),
    edge("land-done", "land", "success", "done"),
  ]);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-reflect-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database);
  executor = new FakeExecutor();
  lifecycle = new RecordingLifecycle();
  mirror = new RecordingMirror();
  service = new WorkflowService({
    repository, executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]), models: () => models, now: () => now.toISOString(),
    todoLifecycle: lifecycle, todoApprovals: mirror,
  });
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a bound run reflects its own lifecycle onto its Todo", () => {
  it("carries a lifted Todo id through prompts, approvals, decisions, and failures", async () => {
    const child = save("called-todo-reflection", [
      { id: "called", type: "trigger", name: "Called", config: { kind: "workflow-call" } },
      { id: "work", type: "employee", name: "Work", config: {
        employee: { source: "fixed", value: "worker" }, prompt: "Handle Todo {{ run.todoId }}.",
      } },
      { id: "gate", type: "approval", name: "Gate", config: { description: "Ship the result?" } },
      { id: "done", type: "end", name: "Done", config: { result: "success" } },
      { id: "stopped", type: "end", name: "Stopped", config: { result: "failure" } },
    ], [
      edge("called-work", "called", "success", "work"),
      edge("work-gate", "work", "success", "gate"),
      edge("gate-done", "gate", "approved", "done"),
      edge("gate-stopped", "gate", "rejected", "stopped"),
    ]);
    const parent = save("todo-reflection-parent", [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      { id: "children", type: "workflow-call", name: "Children", config: {
        workflowId: { source: "fixed", value: child.id },
        input: { todoId: { source: "fixed", value: "OPS-14" } },
        concurrency: 1,
      } },
      { id: "done", type: "end", name: "Done", config: { result: "success" } },
    ], [edge("start-children", "start", "success", "children"), edge("children-done", "children", "success", "done")]);

    const parentRun = await service.startManual({ workflowId: parent.id, input: {} });
    const childSummary = repository.listChildRuns(parentRun.id, "children")[0]!;
    const childRun = service.getRun(child.id, childSummary.runId)!;
    expect(childRun.trigger.todoId).toBe("OPS-14");
    expect(executor.commands.find((command) => command.owner.runId === childRun.id)?.prompt)
      .toContain("Handle Todo OPS-14.");

    await executor.succeed("work");
    expect(mirror.requests).toEqual([expect.objectContaining({
      todoId: "OPS-14", request: "Ship the result?", ref: `workflow:${child.id}:${childRun.id}:gate`,
    })]);
    expect(lifecycle.reflections).toEqual([
      { todoId: "OPS-14", status: "executing", nodeId: "work" },
      { todoId: "OPS-14", status: "in_review", nodeId: "gate" },
    ]);

    await decide(child, childRun.id, "gate", "reject", { decidedBy: "reviewer" });
    expect(lifecycle.decisions).toEqual([expect.objectContaining({
      todoId: "OPS-14", runId: childRun.id, nodeId: "gate", decision: "reject", decidedBy: "reviewer",
    })]);
    expect(lifecycle.reflections.at(-1)).toEqual({ todoId: "OPS-14", status: "blocked", nodeId: "stopped" });
    expect(lifecycle.failures).toEqual([expect.objectContaining({
      todoId: "OPS-14", runId: childRun.id, nodeId: "stopped", code: "workflow-failure-end",
    })]);
  });

  it("reports executing when the first phase dispatches, and does not re-report per phase", async () => {
    const definition = gatedPipeline("reflect-executing");
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-1" });
    expect(lifecycle.reflections).toEqual([{ todoId: "OPS-1", status: "executing", nodeId: "plan" }]);

    // A later phase must not re-assert `executing`: a phase that deliberately
    // moved the Todo somewhere more informative keeps it for the rest of the run.
    await executor.succeed("plan");
    await decide(definition, run.id, "gate", "approve");
    expect(lifecycle.reflections.filter((entry) => entry.status === "executing"))
      .toEqual([{ todoId: "OPS-1", status: "executing", nodeId: "plan" }]);
  });

  it("reports in_review when the run parks, and tells the approver exactly once", async () => {
    const definition = gatedPipeline("reflect-parked");
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-2" });
    await executor.succeed("plan");

    expect(service.getRun(definition.id, run.id)!.status).toBe("waiting");
    expect(lifecycle.reflections.at(-1)).toEqual({ todoId: "OPS-2", status: "in_review", nodeId: "gate" });
    expect(mirror.parked).toEqual([{
      todoId: "OPS-2", nodeId: "gate", ref: `workflow:${definition.id}:${run.id}:gate`,
      request: "Approving merges this branch into main.",
    }]);

    // A recovery sweep over a still-parked run must not ping the approver again.
    await service.recover(now.toISOString());
    expect(mirror.parked).toHaveLength(1);
  });

  it("records an approval decision on the bound Todo exactly once", async () => {
    const definition = gatedPipeline("reflect-approval-decision");
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-10" });
    await executor.succeed("plan");

    await decide(definition, run.id, "gate", "approve", { decidedBy: "reviewer" });

    expect(lifecycle.decisions).toEqual([{
      todoId: "OPS-10", workflowId: definition.id, runId: run.id, nodeId: "gate",
      decision: "approve", decidedBy: "reviewer",
    }]);
  });

  it("passes the picked option and note through the decision hook", async () => {
    const definition = gatedPipeline("reflect-approval-context", { options: ["Variant A", "Variant B"] });
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-12" });
    await executor.succeed("plan");

    await decide(definition, run.id, "gate", "approve", {
      decidedBy: "operator", choice: "Variant B", reason: "Use the quieter layout.",
    });

    expect(lifecycle.decisions).toEqual([{
      todoId: "OPS-12", workflowId: definition.id, runId: run.id, nodeId: "gate",
      decision: "approve", decidedBy: "operator", choice: "Variant B", note: "Use the quieter layout.",
    }]);
  });

  it("reports blocked AND records which node died, with the error and the run id", async () => {
    const definition = gatedPipeline("reflect-failed");
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-3" });
    await executor.failTurn("plan", "Interactive turn failed: invalid_request");

    expect(service.getRun(definition.id, run.id)!.status).toBe("failed");
    expect(lifecycle.reflections.at(-1)).toEqual({ todoId: "OPS-3", status: "blocked", nodeId: "plan" });
    expect(lifecycle.failures).toEqual([{
      todoId: "OPS-3", nodeId: "plan", runId: run.id,
      code: "workflow-step-failed", message: "Interactive turn failed: invalid_request",
    }]);
  });

  it("reports blocked when a run settles on a failure End", async () => {
    const definition = gatedPipeline("reflect-failure-end");
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-4" });
    await executor.succeed("plan");
    await decide(definition, run.id, "gate", "reject");

    expect(service.getRun(definition.id, run.id)!.status).toBe("failed");
    expect(lifecycle.reflections.at(-1)).toEqual({ todoId: "OPS-4", status: "blocked", nodeId: "not-merged" });
    expect(lifecycle.failures.at(-1)).toMatchObject({ todoId: "OPS-4", code: "workflow-failure-end" });
    expect(lifecycle.decisions).toEqual([{
      todoId: "OPS-4", workflowId: definition.id, runId: run.id, nodeId: "gate",
      decision: "reject", decidedBy: "operator",
    }]);
    // Silence means stop: with no note, the authored `rejected` route still runs
    // and nothing goes round again.
    expect(lifecycle.revisions).toEqual([]);
  });

  it("leaves the Todo alone while a routed error edge keeps the run alive", async () => {
    const definition = save("reflect-routed-error", [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      worker("plan"),
      worker("handle-failure"),
      { id: "done", type: "end", name: "Done", config: { result: "success" } },
      { id: "handled", type: "end", name: "Handled", config: { result: "success" } },
    ], [
      edge("start-plan", "start", "success", "plan"),
      edge("plan-done", "plan", "success", "done"),
      edge("plan-error", "plan", "error", "handle-failure"),
      edge("handled-end", "handle-failure", "success", "handled"),
    ]);
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-5" });
    await executor.failTurn("plan", "Interactive turn failed: invalid_request");

    expect(service.getRun(definition.id, run.id)!.status).toBe("running");
    expect(lifecycle.reflections.map((entry) => entry.status)).toEqual(["executing"]);
    expect(lifecycle.failures).toEqual([]);
  });

  it("does not complete the Todo after a gate that was not operator-only", async () => {
    const definition = gatedPipeline("reflect-completed");
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-6" });
    await executor.succeed("plan");
    await decide(definition, run.id, "gate", "approve");
    await executor.succeed("land");

    expect(service.getRun(definition.id, run.id)!.status).toBe("completed");
    expect(lifecycle.reflections.map((entry) => entry.status)).toEqual(["executing", "in_review"]);
    expect(lifecycle.completions).toEqual([]);
  });

  it("completes a bound Todo after an operator-only gate is approved and the run succeeds", async () => {
    const definition = gatedPipeline("reflect-operator-approved", { operatorOnly: true });
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-11" });
    await executor.succeed("plan");
    await decide(definition, run.id, "gate", "approve", { decidedBy: "operator" });

    await executor.succeed("land");

    expect(service.getRun(definition.id, run.id)!.status).toBe("completed");
    expect(lifecycle.completions).toEqual([{
      todoId: "OPS-11", workflowId: definition.id, runId: run.id, nodeId: "gate",
      approvedBy: "operator", approvedAt: now.toISOString(),
    }]);
  });

  it("reflects nothing for a run that is not bound to a Todo", async () => {
    const definition = gatedPipeline("reflect-unbound");
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    await executor.succeed("plan");
    await decide(definition, run.id, "gate", "reject");

    expect(lifecycle.reflections).toEqual([]);
    expect(lifecycle.failures).toEqual([]);
    expect(lifecycle.decisions).toEqual([]);
    expect(lifecycle.completions).toEqual([]);
    expect(mirror.parked).toEqual([]);
  });

  it("does not complete an operator-only gate when it is rejected", async () => {
    const definition = gatedPipeline("reflect-operator-rejected", { operatorOnly: true });
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-13" });
    await executor.succeed("plan");

    await decide(definition, run.id, "gate", "reject", { decidedBy: "operator" });

    expect(service.getRun(definition.id, run.id)!.status).toBe("failed");
    expect(lifecycle.decisions).toHaveLength(1);
    expect(lifecycle.completions).toEqual([]);
  });

  it("runs to completion when the bound Todo can no longer be written", async () => {
    service.dispose();
    service = new WorkflowService({
      repository, executor: executor as unknown as WorkflowSessionExecutor,
      employees: () => new Map([[employee.name, employee]]), models: () => models, now: () => now.toISOString(),
      todoLifecycle: {
        reflect: () => { throw new Error("linkSession: work item OPS-404 not found"); },
        recordApprovalDecision: () => { throw new Error("addComment: work item OPS-404 not found"); },
        complete: () => { throw new TransitionError("children-open", "work item OPS-404 still has open children"); },
        recordFailure: () => { throw new Error("addComment: work item OPS-404 not found"); },
        requestRevision: () => { throw new Error("addComment: work item OPS-404 not found"); },
      },
      todoApprovals: { request: () => {}, notifyParked: () => { throw new Error("no approver session"); } },
    });
    const definition = gatedPipeline("reflect-missing-todo");
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-404" });
    await executor.succeed("plan");
    expect(service.getRun(definition.id, run.id)!.status).toBe("waiting");

    await decide(definition, run.id, "gate", "approve");
    await executor.succeed("land");
    expect(service.getRun(definition.id, run.id)!.status).toBe("completed");
  });
});
