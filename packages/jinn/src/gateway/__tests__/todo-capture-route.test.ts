import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, config, startRouteHarness, stopRouteHarness, unavailableEngines, type Registry, type WorkItems } from "./todo-route-harness.js";

/**
 * The capture routes over a real gateway: what the POST refuses before it
 * spends anything, and what the GET reports afterwards.
 *
 * The stage rules themselves are unit-tested against fixtures in
 * todo-capture-stage.test.ts. What can only be checked here is that the route
 * feeds those rules the true facts, and that every pre-spawn refusal names the
 * setting that fixes it instead of a generic failure.
 */

let registry: Registry;
let workItems: WorkItems;

beforeAll(async () => {
  ({ registry, workItems } = await startRouteHarness());
});

afterAll(async () => {
  await stopRouteHarness();
});

describe("POST /api/todo-captures", () => {
  it("spawns one Todo Shaper session and reports the capture as starting", async () => {
    const before = registry.countSessions();

    const response = await call("POST", "/api/todo-captures", { text: "the closed rail scrolls under the header on mobile" });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ stage: "starting", workItemId: null, error: null });
    expect(response.body.captureId).toEqual(expect.any(String));
    expect(response.body.captureId).toBe(response.body.sessionId);
    expect(registry.countSessions()).toBe(before + 1);
    expect(registry.getSession(response.body.sessionId)).toMatchObject({ employee: "todo-shaper", status: "running" });
  });

  // The operator's own words are what gets stored. The speech note is added to
  // the engine copy only, so a transcript never shows the operator a caveat
  // about their own dictation.
  it("stores the operator's text verbatim even when the capture was dictated", async () => {
    const text = "make the closed rail stop scrolling under the header";

    const response = await call("POST", "/api/todo-captures", { text, speechDerived: true });

    const message = registry.getMessages(response.body.sessionId).find((m: { role: string }) => m.role === "user");
    expect(message?.content).toContain(text);
    expect(message?.content).not.toMatch(/Voice input note/);
  });

  it("refuses an empty capture without creating a session", async () => {
    const before = registry.countSessions();

    const response = await call("POST", "/api/todo-captures", { text: "   " });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/nothing to shape/);
    expect(registry.countSessions()).toBe(before);
  });

  it("refuses an over-long capture and names the cap and the way forward", async () => {
    const before = registry.countSessions();

    const response = await call("POST", "/api/todo-captures", { text: "x".repeat(4_001) });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/4000/);
    expect(response.body.error).toMatch(/full Todo form/);
    expect(registry.countSessions()).toBe(before);
  });

  // A missing engine is the failure journey step 9 provokes. The reason has to
  // be the gateway's real one, naming the override to change.
  it("names an unavailable engine and the setting to change, before spending anything", async () => {
    const before = registry.countSessions();
    const shaperEngine = config().engines.default;
    unavailableEngines.add(shaperEngine);

    try {
      const response = await call("POST", "/api/todo-captures", { text: "something the shaper will never see" });

      expect(response.status).toBe(502);
      expect(response.body.error).toContain(shaperEngine);
      expect(response.body.error).toMatch(/Todo Shaper engine override/);
      expect(registry.countSessions()).toBe(before);
    } finally {
      unavailableEngines.clear();
    }
  });

  it("names the toolset it cannot attach rather than starting a Shaper that cannot create a Todo", async () => {
    const { setJinnAttachGate } = await import("../../mcp/attachment.js");
    const before = registry.countSessions();
    setJinnAttachGate({ ok: false, reason: "the gateway MCP is disabled in config" });

    try {
      const response = await call("POST", "/api/todo-captures", { text: "a capture with no tools to shape it" });

      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/jinn toolset/);
      expect(response.body.error).toMatch(/the gateway MCP is disabled in config/);
      expect(registry.countSessions()).toBe(before);
    } finally {
      setJinnAttachGate({ ok: true });
    }
  });
});

describe("GET /api/todo-captures/:id", () => {
  it("404s an unknown capture", async () => {
    const response = await call("GET", "/api/todo-captures/not-a-session");

    expect(response.status).toBe(404);
    expect(response.body.error).toMatch(/not found/);
  });

  // The reload-recovery property: the stage is read back out of real state, so
  // a second reader with no memory of the first sees the same answer.
  it("reports the Todo the capture's session created, with no stage written down anywhere", async () => {
    const started = await call("POST", "/api/todo-captures", { text: "a capture that will produce a Todo" });
    const captureId = started.body.captureId as string;

    const item = workItems.createWorkItem({
      title: "Closed rail scrolls under the board header on mobile",
      source: "session",
      sourceRef: `session:${captureId}:idempotency:capture`,
      createdBy: `session:${captureId}`,
      department: "platform",
    });

    const response = await call("GET", `/api/todo-captures/${captureId}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      captureId,
      stage: "created",
      workItemId: item.id,
      workItemTitle: "Closed rail scrolls under the board header on mobile",
      routedTo: null,
    });
  });

  it("advances to routed, naming the employee, once a delegate is linked to that Todo", async () => {
    const started = await call("POST", "/api/todo-captures", { text: "a capture that will be delegated" });
    const captureId = started.body.captureId as string;
    const item = workItems.createWorkItem({
      title: "Delegated onward",
      source: "session",
      sourceRef: `session:${captureId}:idempotency:delegated`,
      createdBy: `session:${captureId}`,
    });

    const worker = registry.createSession({
      engine: "codex", source: "web", sourceRef: "route-worker:capture", connector: "web",
      employee: "route-worker", prompt: "do the work",
    });
    workItems.linkSession(item.id, worker.id);

    const response = await call("GET", `/api/todo-captures/${captureId}`);

    expect(response.body).toMatchObject({
      stage: "routed",
      workItemId: item.id,
      routedTo: { kind: "employee", employee: "route-worker", sessionId: worker.id },
    });
  });

  it("surfaces every Todo one capture made rather than hiding the extras", async () => {
    const started = await call("POST", "/api/todo-captures", { text: "a capture that misbehaves" });
    const captureId = started.body.captureId as string;
    const first = workItems.createWorkItem({
      title: "First", source: "session", sourceRef: `session:${captureId}:idempotency:a`, createdBy: `session:${captureId}`,
    });
    const second = workItems.createWorkItem({
      title: "Second", source: "session", sourceRef: `session:${captureId}:idempotency:b`, createdBy: `session:${captureId}`,
    });

    const response = await call("GET", `/api/todo-captures/${captureId}`);

    expect(response.body.workItemId).toBe(first.id);
    expect(response.body.extraWorkItemIds).toEqual([second.id]);
  });
});
