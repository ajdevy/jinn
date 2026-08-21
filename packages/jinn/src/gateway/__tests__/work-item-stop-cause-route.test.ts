import { describe, it, expect } from "vitest";
import { api, ctx, makeReq, makeRes, operatorHeaders, reg, store, toolHeaders } from "./helpers/work-items-route-harness.js";
import { readStopCause } from "../../work-items/stop-cause.js";
import { initDb } from "../../shared/db.js";

/* PLA-157: an escalation nobody can act on is the failure this route exists to
 * stop. "Blocked again for the same reason" tells the operator a Todo stopped
 * and nothing about whose move it is, so the agent lane has to say what has to
 * happen and who has to do it before it may escalate at all. */
describe("POST /api/work-items/:id/status — stop cause", () => {
  const session = () => reg.createSession({ engine: "codex", source: "web", sourceRef: `stop-cause-${Math.random()}` });

  async function post(itemId: string, body: Record<string, unknown>) {
    const cap = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/work-items/${itemId}/status`, body, toolHeaders(session().id)), cap.res, ctx);
    return cap;
  }

  async function put(itemId: string, body: Record<string, unknown>) {
    const cap = makeRes();
    await api.handleApiRequest(makeReq("PUT", `/api/work-items/${itemId}/status`, body, operatorHeaders), cap.res, ctx);
    return cap;
  }

  const item = (title: string) => store.createWorkItem({ title, status: "executing", assignee: "platform-worker" });
  const hint = { what: "approve the vendor invoice", who: "the operator" };
  const cause = (id: string) => readStopCause(initDb(), id);

  it("refuses a hintless escalation and leaves the Todo where it was", async () => {
    const wi = item("hintless");
    const cap = await post(wi.id, { status: "escalated", note: "stuck" });

    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(/unblockHint \{what, who\} is required when escalating/);
    expect(store.getWorkItem(wi.id)?.status).toBe("executing");
  });

  it.each([
    ["an empty what", { what: "", who: "the operator" }],
    ["a whitespace what", { what: "   ", who: "the operator" }],
    ["an empty who", { what: "decide", who: "" }],
    ["a whitespace who", { what: "decide", who: "\t\n" }],
    ["an unknown key", { what: "decide", who: "the operator", when: "soon" }],
    ["a missing half", { what: "decide" }],
    ["a string instead of an object", "the operator decides"],
    ["an array", [{ what: "decide", who: "the operator" }]],
  ])("refuses %s without transitioning", async (_label, unblockHint) => {
    const wi = item("bad hint");
    const cap = await post(wi.id, { status: "escalated", note: "stuck", unblockHint });

    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(/unblockHint must be an object with non-empty what and who strings, and no other keys/);
    expect(store.getWorkItem(wi.id)?.status).toBe("executing");
    expect(cause(wi.id)).toBeUndefined();
  });

  it("accepts a valid hint, escalates, and stores it", async () => {
    const wi = item("good hint");
    const cap = await post(wi.id, { status: "escalated", note: "stuck", unblockHint: hint });

    expect([cap.status, cap.body.workItem?.status]).toEqual([200, "escalated"]);
    expect(cause(wi.id)).toEqual({ unblockHint: hint });
  });

  it("trims the hint it stores, so a padded value cannot read as a different one", async () => {
    const wi = item("padded hint");
    await post(wi.id, { status: "escalated", note: "stuck", unblockHint: { what: "  decide  ", who: " the operator " } });
    expect(cause(wi.id)?.unblockHint).toEqual({ what: "decide", who: "the operator" });
  });

  it("stores a park on a block and projects it onto the compact wire", async () => {
    const wi = item("parked");
    const parkedUntil = new Date(Date.now() + 3_600_000).toISOString();
    const cap = await post(wi.id, { status: "blocked", note: "provider quota", parkedUntil });

    expect([cap.status, cap.body.workItem?.status]).toEqual([200, "blocked"]);
    expect(cause(wi.id)).toEqual({ parkedUntil });

    const list = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items?status=blocked`, undefined, operatorHeaders), list.res, ctx);
    const row = (list.body.workItems as Array<Record<string, unknown>>).find((r) => r.id === wi.id);
    expect(row?.parkedUntil).toBe(parkedUntil);
  });

  it("refuses a parkedUntil that is not a timestamp", async () => {
    const wi = item("bad park");
    const cap = await post(wi.id, { status: "blocked", note: "quota", parkedUntil: "when the quota resets" });

    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(/parkedUntil must be an ISO-8601 timestamp/);
    expect(store.getWorkItem(wi.id)?.status).toBe("executing");
  });

  it("leaves the operator PUT lane alone: it may escalate without a hint", async () => {
    const wi = item("operator escalation");
    const cap = await put(wi.id, { status: "escalated" });
    expect([cap.status, cap.body.workItem?.status]).toEqual([200, "escalated"]);
  });

  it("deletes the cause when the operator routes an escalated Todo back to the queue", async () => {
    const wi = item("unescalated");
    await post(wi.id, { status: "escalated", note: "stuck", unblockHint: hint });
    expect(cause(wi.id)).toEqual({ unblockHint: hint });

    const cap = await put(wi.id, { status: "backlog" });
    expect([cap.status, cap.body.workItem?.status]).toEqual([200, "backlog"]);
    expect(cause(wi.id)).toBeUndefined();
  });

  it("deletes the park when the agent puts a blocked Todo back to work", async () => {
    const wi = item("unparked");
    await post(wi.id, { status: "blocked", note: "quota", parkedUntil: new Date(Date.now() + 3_600_000).toISOString() });
    expect(cause(wi.id)?.parkedUntil).toBeTypeOf("string");

    const cap = await post(wi.id, { status: "executing" });
    expect([cap.status, cap.body.workItem?.status]).toEqual([200, "executing"]);
    expect(cause(wi.id)).toBeUndefined();
  });
});
