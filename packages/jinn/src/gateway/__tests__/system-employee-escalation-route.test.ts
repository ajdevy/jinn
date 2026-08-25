import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";
import { TODO_DISPATCHER_NAME, TODO_SHAPER_NAME } from "../system-employees.js";
import { call, startRouteHarness, stopRouteHarness, type Registry, type WorkItems } from "./todo-route-harness.js";

/**
 * The way out when a system employee can place nobody.
 *
 * ICI-1420 stopped both system personas dead-ending at a comment: a Todo that
 * matches no Workflow and fits no employee is handed UP this route instead, so
 * the COO ends up holding it. Neither employee manages anyone and neither is the
 * org root, so what lets them through is standing over their OWN Todo — the
 * Dispatcher's session is linked to it, the Shaper created it. Pinned here
 * because a persona naming a verb the route refuses is prose, not a hand-off.
 *
 * The harness home ships no executive, which is the default install: approval
 * routing lands on the virtual portal root rather than an employee, and the
 * request still stands.
 */

let registry: Registry;
let workItems: WorkItems;

function callerHeaders(sessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

function systemSession(employee: string, sourceRef: string) {
  return registry.createSession({
    engine: "codex",
    source: "web",
    sourceRef,
    connector: "web",
    employee,
    prompt: "ICI-9: nobody on the roster fits this",
  });
}

async function escalate(itemId: string, sessionId: string) {
  return call(
    "POST",
    `/api/work-items/${itemId}/approval/request`,
    { request: "No Workflow covers this and no employee is a credible fit — please take it over or name the owner." },
    callerHeaders(sessionId),
  );
}

beforeAll(async () => {
  ({ registry, workItems } = await startRouteHarness());
});

afterAll(async () => {
  await stopRouteHarness();
});

describe("POST /api/work-items/:id/approval/request — the system employees' way out", () => {
  it("lets the Dispatcher escalate a Todo its session is linked to", async () => {
    const dispatcher = systemSession(TODO_DISPATCHER_NAME, "todo-dispatcher:escalate-1");
    const item = workItems.createWorkItem({
      title: "Rewrite the onboarding voiceover in Portuguese",
      source: "human",
      department: "platform",
      status: "executing",
    });
    workItems.linkSession(item.id, dispatcher.id);

    const resp = await escalate(item.id, dispatcher.id);

    expect(resp.status).toBe(200);
    expect(resp.body.workItem.approvalState).toBe("pending");
  });

  it("lets the Shaper escalate the Todo it created when dispatch was refused", async () => {
    const shaper = systemSession(TODO_SHAPER_NAME, "todo-shaper:escalate-1");
    const item = workItems.createWorkItem({
      title: "Rewrite the onboarding voiceover in Portuguese",
      source: "session",
      sourceRef: `session:${shaper.id}:idempotency:escalate-1`,
      createdBy: `session:${shaper.id}`,
      department: "platform",
    });

    const resp = await escalate(item.id, shaper.id);

    expect(resp.status).toBe(200);
    expect(resp.body.workItem.approvalState).toBe("pending");
  });

  // The standing is the Todo's, not the employee name's: the same caller on a
  // Todo it neither created nor is linked to is still refused.
  it("still refuses a system employee on a Todo it has no standing over", async () => {
    const dispatcher = systemSession(TODO_DISPATCHER_NAME, "todo-dispatcher:escalate-2");
    const item = workItems.createWorkItem({
      title: "Someone else's Todo",
      source: "human",
      department: "platform",
      assignee: "route-worker",
    });

    const resp = await escalate(item.id, dispatcher.id);

    expect(resp.status).toBe(403);
  });
});
