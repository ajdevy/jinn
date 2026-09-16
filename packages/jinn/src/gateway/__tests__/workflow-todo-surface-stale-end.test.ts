import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wf-todo-stale-end-"));
process.env.JINN_HOME = tmp;

type Surface = typeof import("../workflow-todo-surface.js");
type Store = typeof import("../../work-items/store.js");
type Transitions = typeof import("../../work-items/transitions.js");
type Approvals = typeof import("../../work-items/approvals.js");

let surface: Surface;
let store: Store;
let transitions: Transitions;
let approvals: Approvals;

function armedTodo(title: string): string {
  return store.createWorkItem({ title, source: "human", status: "assigned" }).id;
}

function reflect(
  todoId: string,
  status: "executing" | "in_review" | "blocked",
  nodeId = "plan",
  runId = "run_1",
): void {
  surface.workflowTodoLifecycle.reflect({ todoId, status, workflowId: "pipeline", runId, nodeId });
}

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  transitions = await import("../../work-items/transitions.js");
  approvals = await import("../../work-items/approvals.js");
  surface = await import("../workflow-todo-surface.js");
});

beforeEach(() => {
  transitions.setTodoStatusChangeListener(null);
  approvals.setTodoApprovalDecisionListener(null);
});

describe("stale failure Ends cannot stomp a live successor (PLA-221)", () => {
  it("does not let a stale failure End stomp a successor executing Todo", () => {
    const id = armedTodo("rearmed while the old End was still firing");
    reflect(id, "executing");
    transitions.transition(id, "assigned", "availability-resume", {
      requeue: true,
      detail: { workflowId: "pipeline", availabilityResume: true },
    });
    reflect(id, "executing", "plan", "run_2");

    reflect(id, "blocked", "land", "run_1");

    expect(store.getWorkItem(id)!.status).toBe("executing");
  });

  it("does not let a stale failure End stomp an operator or employee move to assigned", () => {
    const id = armedTodo("rescued while the old End was still firing");
    reflect(id, "executing");
    transitions.transition(id, "assigned", "operator", { requeue: true });

    reflect(id, "blocked", "land");

    expect(store.getWorkItem(id)!.status).toBe("assigned");
  });

  it("still blocks a quiet Todo this run itself left executing", () => {
    const id = armedTodo("this run died");
    reflect(id, "executing");
    reflect(id, "blocked", "land");
    expect(store.getWorkItem(id)!.status).toBe("blocked");
  });

  it("still blocks when THIS run reflected in_review and then failed", () => {
    const id = armedTodo("gate parked then the land died");
    reflect(id, "executing");
    reflect(id, "in_review", "gate");
    reflect(id, "blocked", "land");
    expect(store.getWorkItem(id)!.status).toBe("blocked");
  });

  it("does not stomp in_review a successor already moved to, with no matching run", () => {
    const id = armedTodo("phase reviewed it, then a stale End fired");
    transitions.transition(id, "in_review", "session:abc", { agent: true });

    reflect(id, "blocked", "land");

    expect(store.getWorkItem(id)!.status).toBe("in_review");
  });
});
