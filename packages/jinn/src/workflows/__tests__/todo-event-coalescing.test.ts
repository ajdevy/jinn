import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkflowTodoEventClaimOutcome, WorkflowTodoEventFeed, WorkflowTodoStatusEvent }
  from "../../work-items/workflow-event-feed.js";
import type { WorkflowDefinition, WorkflowNode } from "../model.js";
import type { WorkflowRepository } from "../repository.js";
import type { WorkflowRunner } from "../runner.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-todo-event-coalescing-"));
process.env.JINN_HOME = home;

type Store = typeof import("../../work-items/store.js");
type Triggers = typeof import("../trigger-service.js");

let store: Store;
let triggers: Triggers;

function definitionWith(id: string, label?: string): WorkflowDefinition {
  const trigger: WorkflowNode = {
    id: "start", type: "trigger", name: "Todo",
    config: { kind: "todo-status", status: "in_review", ...(label === undefined ? {} : { label }) },
  };
  return { id, title: id, revision: 1, enabled: true, nodes: [trigger], edges: [] } as unknown as WorkflowDefinition;
}

let definitions: WorkflowDefinition[] = [];
let pending: WorkflowTodoStatusEvent[] = [];
const started: Array<{ workflowId: string; idempotencyKey: string; payload: unknown }> = [];
const completed: Array<{ eventId: string; outcomes: WorkflowTodoEventClaimOutcome[] }> = [];

const repository = {
  listDefinitions: () => ({ items: definitions.map((item) => ({ id: item.id })), nextCursor: null }),
  getDefinition: (id: string) => definitions.find((item) => item.id === id),
  createRun: ({ workflowId, idempotencyKey, trigger }: {
    workflowId: string; idempotencyKey: string; trigger: { payload: unknown };
  }) => {
    started.push({ workflowId, idempotencyKey, payload: trigger.payload });
    return { id: `run-${started.length}` };
  },
  getRun: (_workflowId: string, runId: string) => ({ id: runId, status: "completed" }),
} as unknown as WorkflowRepository;

const runner = { start: async (runId: string) => ({ id: runId, status: "completed" }) } as unknown as WorkflowRunner;

/** Every event is fresh to the feed, so nothing but the coalescing under test
 *  can stop one of them firing. `completeEvent` is the spy: it is where the
 *  outcome recorded against each declined event shows up. */
const feed: WorkflowTodoEventFeed = {
  claimEvent: (_id, definitionIds) => ({ state: "acquired", definitionIds }),
  completeEvent: (eventId, outcomes) => { completed.push({ eventId, outcomes }); },
  releaseEvent: () => {},
  listPendingEvents: () => pending,
};

function event(id: string, workItemId: string, labels: string[] = []): WorkflowTodoStatusEvent {
  return {
    id, workItemId, fromStatus: "executing", toStatus: "in_review", actor: "operator", armedAsDelegate: null,
    item: {
      source: "human", department: null, assignee: null,
      labels: labels.map((name) => ({ id: `lbl_${name}`, name })),
      live: { assignee: null, parentId: null },
    },
  };
}

function outcomesFor(eventId: string): WorkflowTodoEventClaimOutcome[] {
  return completed.filter((entry) => entry.eventId === eventId).flatMap((entry) => entry.outcomes);
}

function keys(): string[] { return started.map((run) => run.idempotencyKey); }

async function sweep(): Promise<number> {
  return new triggers.WorkflowTriggerService(repository, runner, () => "now", feed).recoverTodoEvents();
}

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  triggers = await import("../trigger-service.js");
});

beforeEach(() => {
  started.length = 0;
  completed.length = 0;
  pending = [];
  definitions = [definitionWith("claim-flow")];
});

describe("coalescing a backlog of pending Todo events", () => {
  it("starts only the newest qualifying event's run", async () => {
    const item = store.createWorkItem({ title: "label restored" });
    pending = [event("event-1", item.id), event("event-2", item.id), event("event-3", item.id)];

    await sweep();

    expect(keys()).toEqual(["todo:event-3"]);
  });

  it("records the older events as superseded by the one that won", async () => {
    const item = store.createWorkItem({ title: "three moves" });
    pending = [event("event-1", item.id), event("event-2", item.id), event("event-3", item.id)];

    await sweep();

    for (const eventId of ["event-1", "event-2"]) {
      expect(outcomesFor(eventId)).toEqual([{
        workflowId: "claim-flow",
        outcome: "superseded",
        detail: `Todo event ${eventId} superseded by event-3, a newer in_review event on ${item.id}.`,
      }]);
    }
    expect(outcomesFor("event-3").map((outcome) => outcome.outcome)).toEqual(["started"]);
  });

  it("never coalesces one Todo's events against another's", async () => {
    const first = store.createWorkItem({ title: "one" });
    const second = store.createWorkItem({ title: "two" });
    pending = [event("event-1", first.id), event("event-2", second.id)];

    await sweep();

    expect(keys()).toEqual(["todo:event-1", "todo:event-2"]);
  });

  it("still starts an event superseded for one workflow when it is the newest for another", async () => {
    definitions = [definitionWith("unfiltered"), definitionWith("build-only", "build")];
    // A Todo whose row is gone cannot be double-worked, so the Todo claim never
    // holds the second fire and per-definition coalescing is what is observed.
    pending = [event("event-1", "ICI-999999", ["build"]), event("event-2", "ICI-999999")];

    await sweep();

    expect(started).toEqual([
      { workflowId: "build-only", idempotencyKey: "todo:event-1", payload: expect.anything() },
      { workflowId: "unfiltered", idempotencyKey: "todo:event-2", payload: expect.anything() },
    ]);
    expect(outcomesFor("event-1").filter((outcome) => outcome.outcome === "superseded")).toEqual([{
      workflowId: "unfiltered",
      outcome: "superseded",
      detail: "Todo event event-1 superseded by event-2, a newer in_review event on ICI-999999.",
    }]);
  });

  it("leaves a filtered-out event suppressed with its own reason, and the survivor's payload alone", async () => {
    definitions = [definitionWith("build-only", "build")];
    const item = store.createWorkItem({ title: "one labelled, one not" });
    pending = [event("event-1", item.id), event("event-2", item.id, ["build"])];

    await sweep();

    expect(outcomesFor("event-1")).toEqual([{
      workflowId: "build-only",
      outcome: "suppressed",
      detail: "Todo event event-1 suppressed: label filter build does not match.",
    }]);
    expect(started).toEqual([{
      workflowId: "build-only",
      idempotencyKey: "todo:event-2",
      payload: {
        todoId: item.id, fromStatus: "executing", toStatus: "in_review", actor: "operator",
        source: "human", department: null, assignee: null, labels: ["build"], labelList: "build",
      },
    }]);
  });

  it("leaves a single pending event exactly as it was", async () => {
    const item = store.createWorkItem({ title: "moved once" });
    pending = [event("event-1", item.id)];

    const count = await sweep();

    expect(count).toBe(1);
    expect(keys()).toEqual(["todo:event-1"]);
    expect(outcomesFor("event-1").map((outcome) => outcome.outcome)).toEqual(["started"]);
  });
});
