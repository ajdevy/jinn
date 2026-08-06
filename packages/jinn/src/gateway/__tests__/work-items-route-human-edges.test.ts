import { describe, it, expect } from "vitest";
import { api, ctx, makeReq, makeRes, operatorHeaders, reg, store, toolHeaders } from "./helpers/work-items-route-harness.js";

/* The board's design contract (design-doc §5/§6) requires the human-only
 * edges transitions.ts already supports: reopening closed work, unblocking,
 * routing escalated items. The operator PUT lane carries human authority —
 * it passes human:true, accepts every declared status target, and treats the
 * blocked/escalated note as asked-for-after (optional) rather than demanded
 * up front. The agent POST lane is UNCHANGED: allowlisted targets, note
 * required, sticky terminals locked. */
describe("PUT /api/work-items/:id/status — the operator human-surface lane (Todos v2 slice 6)", () => {
  it.each([
    // Drag-to-Backlog reopen: closed work loses its closedAt as it comes back.
    ["done", "backlog", { status: "backlog", closedAt: null }],
    ["cancelled", "backlog", { status: "backlog", closedAt: null }],
    ["escalated", "backlog", { status: "backlog" }],
    ["escalated", "assigned", { status: "assigned" }],
    ["escalated", "in_review", { status: "in_review" }],
    ["blocked", "backlog", { status: "backlog" }],
    ["blocked", "assigned", { status: "assigned" }],
    // No note: the reason is asked for in the banner after the drop commits.
    ["executing", "blocked", { status: "blocked" }],
  ] as const)("moves %s → %s on the human-only edges", async (from, target, expectedItem) => {
    const item = store.createWorkItem({ title: `Human edge ${from} to ${target}`, status: from });
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${item.id}/status`, { status: target }, operatorHeaders),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(200);
    expect(cap.body.workItem).toMatchObject(expectedItem);
  });

  it("still records the note when the operator PUT provides one", async () => {
    const item = store.createWorkItem({ title: "Block with note", status: "executing" });
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${item.id}/status`, { status: "escalated", note: "needs owner call" }, operatorHeaders),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(200);
    expect(store.listWorkItemEvents(item.id).at(-1)).toMatchObject({
      toStatus: "escalated",
      detail: { note: "needs owner call" },
    });
  });

  it.each([
    ["a truly illegal edge", "executing", "backlog", [/illegal transition executing → backlog/]],
    // The refusal names every status, so the operator can see what was allowed.
    ["an unknown status", "backlog", "paused", [/status must be one of/, /backlog/]],
  ] as const)("still refuses an operator PUT along %s", async (_name, from, target, messages) => {
    const item = store.createWorkItem({ title: `Refused ${from} to ${target}`, status: from });
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${item.id}/status`, { status: target }, operatorHeaders),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(400);
    for (const message of messages) expect(cap.body.error).toMatch(message);
    expect(store.getWorkItem(item.id)?.status).toBe(from);
  });

  it("keeps the agent POST lane bounded: backlog is settable, note still required, sticky exits locked", async () => {
    const caller = reg.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "agent-lane-pin",
      employee: "platform-worker",
    });

    // "Not now" is a legitimate agent move: a picked-up Todo goes back down.
    const owned = store.createWorkItem({ title: "Agent backlog allowed", status: "assigned", assignee: "platform-worker" });
    const backlog = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${owned.id}/status`, { status: "backlog" }, toolHeaders(caller.id)),
      backlog.res,
      ctx,
    );
    expect(backlog.status).toBe(200);
    expect(store.getWorkItem(owned.id)?.status).toBe("backlog");

    // …but cancelled is still not an agent target at all.
    const cancel = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${owned.id}/status`, { status: "cancelled" }, toolHeaders(caller.id)),
      cancel.res,
      ctx,
    );
    expect(cancel.status).toBe(403);
    expect(cancel.body.error).toMatch(/human surface decision/);

    // Note still demanded from agents entering blocked/escalated.
    const noteLess = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${owned.id}/status`, { status: "blocked" }, toolHeaders(caller.id)),
      noteLess.res,
      ctx,
    );
    expect(noteLess.status).toBe(400);
    expect(noteLess.body.error).toMatch(/note is required/);

    // Sticky terminals still locked to agents (human-required refusal).
    const sticky = store.createWorkItem({ title: "Agent sticky locked", status: "done", assignee: "platform-worker" });
    const exitTry = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${sticky.id}/status`, { status: "in_review" }, toolHeaders(caller.id)),
      exitTry.res,
      ctx,
    );
    expect(exitTry.status).toBe(403);
    expect(exitTry.body.error).toMatch(/human decision/);
    expect(store.getWorkItem(sticky.id)?.status).toBe("done");
  });
});
