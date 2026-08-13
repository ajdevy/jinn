import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import type { WorkflowTodoEventClaimOutcome, WorkflowTodoEventFeed, WorkflowTodoStatusEvent }
  from "../../work-items/workflow-event-feed.js";
import type { WorkflowDefinition, WorkflowNode } from "../model.js";
import type { WorkflowRepository } from "../repository.js";
import type { WorkflowRunner } from "../runner.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-respawn-trigger-"));
process.env.JINN_HOME = home;

type Store = typeof import("../../work-items/store.js");
type Claims = typeof import("../../work-items/claims.js");
type Runs = typeof import("../../work-items/runs.js");
type RouteClaims = typeof import("../../gateway/todo-claim.js");
type Triggers = typeof import("../trigger-service.js");

let store: Store;
let claims: Claims;
let runs: Runs;
let routeClaims: RouteClaims;
let triggers: Triggers;

const trigger: WorkflowNode = {
  id: "start", type: "trigger", name: "Todo", config: { kind: "todo-status", status: "in_review" },
};
const definition = {
  id: "guarded-flow", title: "Guarded flow", revision: 1, enabled: true, nodes: [trigger], edges: [],
} as unknown as WorkflowDefinition;

const started: string[] = [];
let reported: WorkflowTodoEventClaimOutcome[] = [];

const repository = {
  listDefinitions: () => ({ items: [{ id: definition.id }], nextCursor: null }),
  getDefinition: () => definition,
  createRun: ({ idempotencyKey }: { idempotencyKey: string }) => {
    started.push(idempotencyKey);
    return { id: `run-${started.length}` };
  },
  getRun: (_workflowId: string, runId: string) => ({ id: runId, status: "completed" }),
} as unknown as WorkflowRepository;

const runner = { start: async (runId: string) => ({ id: runId, status: "completed" }) } as unknown as WorkflowRunner;

const feed: WorkflowTodoEventFeed = {
  claimEvent: (_id, definitionIds) => ({ state: "acquired", definitionIds }),
  completeEvent: (_id: string, outcomes: WorkflowTodoEventClaimOutcome[]) => { reported = outcomes; },
  releaseEvent: () => {},
  listPendingEvents: () => pending,
};

let pending: WorkflowTodoStatusEvent[] = [];

function event(id: string, workItemId: string): WorkflowTodoStatusEvent {
  return {
    id, workItemId, fromStatus: "executing", toStatus: "in_review", actor: "operator", armedAsDelegate: null,
    item: { source: "human", department: null, assignee: null, labels: [], live: { assignee: null, parentId: null } },
  };
}

/** A Todo the guards hold: it completed minutes ago and nobody has looked. */
function guardedTodo(title: string): string {
  const item = store.createWorkItem({ title });
  const run = runs.openWorkItemRun({ workItemId: item.id, sessionId: `s-${item.id}` });
  runs.closeWorkItemRun(run.id, { outcome: "completed", endedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
  return item.id;
}

/** Enough of a response for the two route claim gates, which only touch it when
 *  they REFUSE — so a test that sees it touched has already found the bug. */
function response(): ServerResponse {
  return {
    writeHead: () => { throw new Error("the route answered instead of acquiring"); },
    setHeader: () => {},
    end: () => { throw new Error("the route answered instead of acquiring"); },
  } as unknown as ServerResponse;
}

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  claims = await import("../../work-items/claims.js");
  runs = await import("../../work-items/runs.js");
  routeClaims = await import("../../gateway/todo-claim.js");
  triggers = await import("../trigger-service.js");
});

beforeEach(() => { started.length = 0; reported = []; pending = []; });

describe("an automated Todo-status fire meets the respawn guards", () => {
  it("starts no run, takes no claim, and reports the hold as suppressed", async () => {
    const id = guardedTodo("just finished");
    pending = [event("event-guarded", id)];

    const service = new triggers.WorkflowTriggerService(repository, runner, () => "now", feed);
    expect(await service.recoverTodoEvents()).toBe(0);

    expect(started).toEqual([]);
    expect(claims.getWorkItemClaim(id)).toBeUndefined();
    expect(reported).toEqual([{
      workflowId: definition.id,
      outcome: "suppressed",
      detail: expect.stringContaining("recent_success") as unknown as string,
    }]);
  });

  it("appends exactly one respawn_guard_held event naming the guard and its reason", async () => {
    const id = guardedTodo("audited hold");
    pending = [event("event-audited", id)];

    const service = new triggers.WorkflowTriggerService(repository, runner, () => "now", feed);
    await service.recoverTodoEvents();

    const holds = store.listWorkItemEvents(id).filter((entry) => entry.kind === "respawn_guard_held");
    expect(holds).toHaveLength(1);
    expect(holds[0].actor).toBe("workflow:event-audited");
    expect(holds[0].detail).toMatchObject({ guard: "recent_success" });
    expect(String(holds[0].detail?.reason)).toContain("no human has looked");
  });

  it("still starts the run for a Todo no guard holds", async () => {
    const item = store.createWorkItem({ title: "nothing behind it" });
    pending = [event("event-clear", item.id)];

    const service = new triggers.WorkflowTriggerService(repository, runner, () => "now", feed);
    expect(await service.recoverTodoEvents()).toBe(1);

    expect(started).toEqual(["todo:event-clear"]);
    expect(claims.getWorkItemClaim(item.id)?.owner).toBe("workflow:event-clear");
  });
});

describe("human-initiated pickup is not guarded", () => {
  it("the operator's Dispatch still claims a Todo the guards hold", () => {
    const id = guardedTodo("operator says do it again");
    const claim = routeClaims.claimTodoForDispatch(response(), id);
    expect(claim).toBeDefined();
    expect(claims.getWorkItemClaim(id)?.owner).toBe(claim?.owner);
  });

  it("delegate_task still claims a Todo the guards hold", () => {
    const id = guardedTodo("delegated anyway");
    const claim = routeClaims.claimTodoForDelegation(response(), id);
    expect(claim).toBeDefined();
    expect(claims.getWorkItemClaim(id)?.owner).toBe(claim?.owner);
  });
});
