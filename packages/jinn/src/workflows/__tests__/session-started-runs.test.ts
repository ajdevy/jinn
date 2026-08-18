import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Employee,
  ModelRegistry,
  WorkflowAttemptCommand,
  WorkflowAttemptCompletionListener,
} from "../../shared/types.js";
import type { WorkflowDefinition } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";

const NOW = "2026-08-18T12:00:00.000Z";
const employee: Employee = {
  name: "worker", displayName: "Worker", department: "operations", rank: "employee",
  engine: "test-engine", model: "test-model", effortLevel: "high", persona: "Complete work.",
};
const models: ModelRegistry = {
  "test-engine": {
    name: "test-engine", available: true, defaultModel: "test-model", effortMechanism: "codex-config",
    models: [{ id: "test-model", label: "Test", supportsEffort: true, effortLevels: ["high"] }],
  },
};

class Executor {
  readonly stopped: string[] = [];
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();
  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    return { sessionId: attemptSession(command.owner.runId) };
  }
  async stopAttempt(input: { sessionId: string }): Promise<void> { this.stopped.push(input.sessionId); }
  subscribe(listener: WorkflowAttemptCompletionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  readTerminalCompletion(): null { return null; }
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: Executor;
let service: WorkflowService;

/** Every Workflow here has the same shape, so a run's only attempt session is
 *  addressable from its run id alone. */
function attemptSession(runId: string): string { return `session:${runId}:work`; }

function save(id: string): WorkflowDefinition {
  const created = service.createDefinition({ id, title: id });
  const saved = service.saveDefinition({ ...created, nodes: [
    { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
    { id: "work", type: "employee", name: "Work", config: {
      employee: { source: "fixed", value: "worker" }, prompt: "Do the work.",
    } },
    { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
  ], edges: [
    { id: "start-work", from: { nodeId: "start", port: "success" }, to: { nodeId: "work", port: "input" } },
    { id: "work-finish", from: { nodeId: "work", port: "success" }, to: { nodeId: "finish", port: "input" } },
  ] }, created.revision);
  return service.setEnabled({ id, enabled: true, expectedRevision: saved.revision });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-session-started-runs-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database, () => NOW);
  executor = new Executor();
  service = new WorkflowService({
    repository,
    executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]),
    models: () => models,
    now: () => NOW,
  });
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Workflow runs started from an attempt session", () => {
  it("refuses a run of the Workflow the calling attempt is itself running", async () => {
    const alpha = save("alpha-flow");
    const run = await service.startManual({ workflowId: alpha.id, input: {} });

    await expect(service.startManual({
      workflowId: alpha.id, input: {}, callerSessionId: attemptSession(run.id),
    })).rejects.toMatchObject({ code: "bad-input", message: "Workflow call recursion is not allowed." });
    expect(service.listRuns(alpha.id, {}).items).toHaveLength(1);
  });

  it("walks the ancestry through a session-started hop, not only Workflow Calls", async () => {
    const alpha = save("alpha-flow");
    const beta = save("beta-flow");
    const alphaRun = await service.startManual({ workflowId: alpha.id, input: {} });
    const betaRun = await service.startManual({
      workflowId: beta.id, input: {}, callerSessionId: attemptSession(alphaRun.id),
    });

    await expect(service.startManual({
      workflowId: alpha.id, input: {}, callerSessionId: attemptSession(betaRun.id),
    })).rejects.toMatchObject({ code: "bad-input", message: "Workflow call recursion is not allowed." });
  });

  it("refuses an ancestry nested deeper than the cap", async () => {
    const chain = save("chain-flow");
    const target = save("target-flow");
    const seed = await service.startManual({ workflowId: chain.id, input: {} });
    const resolvedConfig = service.getRun(chain.id, seed.id)!.attempts[0]!.resolvedConfig;
    let runId = seed.id;
    for (let depth = 0; depth < 129; depth += 1) {
      const caller = { workflowId: chain.id, runId, nodeId: "work" };
      runId = repository.createRun({ workflowId: chain.id, input: {},
        trigger: { nodeId: "start", kind: "manual", payload: { caller } } }).id;
    }
    const leaf = repository.getRun(chain.id, runId)!;
    repository.mutateRun(leaf.id, leaf.revision, (tx) => {
      tx.setNodeStatus("work", "running", { activated: true, startedAt: NOW });
      const attempt = tx.createAttempt({ nodeId: "work", resolvedConfig, input: {} });
      tx.settleAttempt("work", attempt.attempt, { status: "running", sessionId: attemptSession(leaf.id) });
    });

    await expect(service.startManual({
      workflowId: target.id, input: {}, callerSessionId: attemptSession(leaf.id),
    })).rejects.toMatchObject({ code: "bad-input", message: "Workflow caller ancestry is too deep." });
  }, 30_000);

  it("links a sanctioned spawn under the calling node and cancels it with the parent", async () => {
    const alpha = save("alpha-flow");
    const beta = save("beta-flow");
    const alphaRun = await service.startManual({ workflowId: alpha.id, input: {} });
    const betaRun = await service.startManual({
      workflowId: beta.id, input: {}, callerSessionId: attemptSession(alphaRun.id),
    });

    expect(service.getRun(alpha.id, alphaRun.id)!.childRuns).toEqual([{
      runId: betaRun.id, workflowId: beta.id, nodeId: "work", status: "running", startedAt: NOW,
    }]);

    await service.cancelRun({ workflowId: alpha.id, runId: alphaRun.id, reason: "Parent stopped." });

    expect(service.getRun(beta.id, betaRun.id)!.status).toBe("cancelled");
  });

  it("leaves a run started outside an attempt exactly as it was", async () => {
    const alpha = save("alpha-flow");
    const lookup = vi.spyOn(repository, "findAttemptBySessionId");

    const operator = await service.startManual({ workflowId: alpha.id, input: {} });
    expect(lookup).not.toHaveBeenCalled();
    expect(operator.trigger).toEqual({ nodeId: "start", kind: "manual", payload: {} });

    const outsider = await service.startManual({
      workflowId: alpha.id, input: {}, callerSessionId: "session-of-nobody", todoId: "PLA-1",
    });
    expect(outsider.trigger).toEqual({ nodeId: "start", kind: "manual", payload: {}, todoId: "PLA-1" });
    expect(service.getRun(alpha.id, operator.id)!.childRuns).toEqual([]);
  });
});
