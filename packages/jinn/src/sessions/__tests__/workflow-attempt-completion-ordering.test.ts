import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  Employee,
  Engine,
  EngineRunOpts,
  JinnConfig,
  WorkflowAttemptCommand,
  WorkflowAttemptCompletion,
} from "../../shared/types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-attempt-completion-ordering-"));
process.env.JINN_HOME = home;

type ManagerModule = typeof import("../manager.js");
type DbModule = typeof import("../../shared/db.js");

let managerModule: ManagerModule;
let dbModule: DbModule;

const employee: Employee = {
  name: "worker",
  displayName: "Worker",
  department: "operations",
  rank: "employee",
  engine: "test-engine",
  model: "test-model",
  persona: "Complete the assigned workflow step.",
};

function command(runId: string): WorkflowAttemptCommand {
  return {
    owner: { workflowId: "content-flow", runId, nodeId: "draft", attempt: 1 },
    employeeId: employee.name,
    engine: employee.engine,
    model: employee.model,
    effort: "high",
    prompt: "Draft the release.",
  };
}

function sessionKeyFor(input: WorkflowAttemptCommand): string {
  const { workflowId, runId, nodeId, attempt } = input.owner;
  return `workflow:${workflowId}:${runId}:${nodeId}:${attempt}`;
}

function config(): JinnConfig {
  return {
    gateway: { host: "127.0.0.1", port: 7799 },
    engines: {
      default: "test-engine",
      "test-engine": { bin: process.execPath, model: "test-model", effortLevel: "high" },
    },
    models: {
      "test-engine": {
        default: "test-model",
        models: [{ id: "test-model", label: "Test model" }],
      },
    },
    connectors: {},
    logging: { file: false, stdout: false, level: "info" },
    sessions: {},
    mcp: {},
    portal: { setupComplete: true },
  } as unknown as JinnConfig;
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let index = 0; index < 100 && !check(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBe(true);
}

function managerWith(runs: EngineRunOpts[]) {
  const engine: Engine = {
    name: "test-engine",
    async run(options) {
      runs.push(options);
      return { sessionId: "engine-session", result: `Turn ${runs.length} complete.` };
    },
  };
  return new managerModule.SessionManager(
    config(),
    new Map([[engine.name, engine]]),
    "test-boot",
    (id) => id === employee.name ? employee : undefined,
  );
}

/** Statuses of the internal dispatch rows for a session, oldest first. */
function dispatchStatuses(sessionId: string): string[] {
  const rows = dbModule.initDb().prepare(
    "SELECT status FROM queue_items WHERE session_id = ? AND internal = 1 ORDER BY created_at, position",
  ).all(sessionId) as Array<{ status: string }>;
  return rows.map((row) => row.status);
}

beforeAll(async () => {
  managerModule = await import("../manager.js");
  dbModule = await import("../../shared/db.js");
  dbModule.initDb();
});

beforeEach(() => {
  dbModule.initDb().exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
});

describe("workflow attempt completion ordering", () => {
  it("claims a reminder dispatched from inside the completion listener", async () => {
    const runs: EngineRunOpts[] = [];
    const manager = managerWith(runs);
    const events: WorkflowAttemptCompletion[] = [];
    const rowsWhenDelivered: string[][] = [];
    let reminderError: unknown;

    manager.subscribeWorkflowAttemptCompletion(async (event) => {
      events.push(event);
      rowsWhenDelivered.push(dispatchStatuses(event.sessionId));
      // The runner answers the first completion by dispatching a stop-nudge, so
      // the reminder is claimed from inside the listener rather than after it.
      if (event.turn !== 1) return;
      try {
        await manager.remindWorkflowAttempt(event.sessionId, "Submit your output.");
      } catch (error) {
        reminderError = error;
      }
    });

    await manager.runWorkflowAttempt(command("run-listener"));
    await waitFor(() => events.length === 2 || reminderError !== undefined);

    expect(reminderError).toBeUndefined();
    expect(rowsWhenDelivered[0]).toEqual(["completed"]);
    expect(runs.map((run) => run.prompt)).toEqual(["Draft the release.", "Submit your output."]);
    expect(events.map((event) => event.turn)).toEqual([1, 2]);
  });

  it("emits no completion for a turn the queue skipped", async () => {
    const runs: EngineRunOpts[] = [];
    const manager = managerWith(runs);
    const events: WorkflowAttemptCompletion[] = [];
    manager.subscribeWorkflowAttemptCompletion((event) => { events.push(event); });

    const input = command("run-cancelled");
    const { sessionId } = await manager.runWorkflowAttempt(input);
    manager.getQueue().clearQueue(sessionKeyFor(input));

    await waitFor(() => dispatchStatuses(sessionId).includes("completed"));
    expect(runs).toEqual([]);
    expect(events).toEqual([]);
  });

  it("emits no completion for a turn whose run threw", async () => {
    const runs: EngineRunOpts[] = [];
    const manager = managerWith(runs);
    const events: WorkflowAttemptCompletion[] = [];
    manager.subscribeWorkflowAttemptCompletion((event) => { events.push(event); });

    const { sessionId } = await manager.runWorkflowAttempt(command("run-threw"));
    await waitFor(() => events.length === 1);

    // runTurn settles an engine failure itself, so the queued task only rejects
    // when the call around it throws — which is the seam being stubbed here.
    (manager as unknown as { runSession: () => Promise<void> }).runSession = async () => {
      throw new Error("Dispatch exploded.");
    };
    await manager.remindWorkflowAttempt(sessionId, "Second turn.");

    await waitFor(() => dispatchStatuses(sessionId).filter((status) => status === "completed").length === 2);
    expect(runs).toHaveLength(1);
    expect(events).toHaveLength(1);
  });
});
