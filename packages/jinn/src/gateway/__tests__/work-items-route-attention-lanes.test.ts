import { describe, expect, it } from "vitest";
import { api, ctx, makeReq, makeRes, store, toolHeaders, reg } from "./helpers/work-items-route-harness.js";

/**
 * PLA-240 data contract: Attention/list grouping is fed only from
 * GET /api/work-items?needsAttentionFor=me. Recovering leftovers must be in
 * that feed with attentionLane=recovering so the UI can split them out of
 * Needs you.
 */
describe("GET /api/work-items?needsAttentionFor=me attention lanes", () => {
  it("returns a recovering blocked Todo with attentionLane recovering, including for the COO who is not the assignee", async () => {
    const coo = reg.createSession({ engine: "codex", source: "web", sourceRef: "coo-lanes", title: "coo", employee: "coo" });
    const item = store.createWorkItem({
      title: "quota parked build", status: "blocked", assignee: "platform-worker",
    });
    const rows = await import("../../work-items/recovery-rows.js");
    rows.upsertWorkItemRecovery({
      workItemId: item.id,
      incidentId: "run_old",
      class: "transient",
      lane: "recovering",
      reason: "provider availability",
    });

    const res = makeRes();
    await api.handleApiRequest(
      makeReq("GET", "/api/work-items?needsAttentionFor=me&limit=50", undefined, toolHeaders(coo.id)),
      res.res,
      ctx,
    );
    expect(res.status).toBe(200);
    const row = (res.body.workItems as Array<Record<string, unknown>>).find((entry) => entry.id === item.id);
    expect(row).toMatchObject({ id: item.id, status: "blocked", attentionLane: "recovering" });
  });

  it("returns a manager-lane in_review leftover that is not a pending approval", async () => {
    const coo = reg.createSession({ engine: "codex", source: "web", sourceRef: "coo-mgr", title: "coo", employee: "coo" });
    const item = store.createWorkItem({
      title: "approved landing leftover", status: "in_review", assignee: "platform-worker",
    });
    const rows = await import("../../work-items/recovery-rows.js");
    rows.upsertWorkItemRecovery({
      workItemId: item.id,
      incidentId: "anomaly:approved-landed-open",
      class: "code",
      lane: "manager",
      reason: "approved landing is still open",
    });

    const res = makeRes();
    await api.handleApiRequest(
      makeReq("GET", "/api/work-items?needsAttentionFor=me&limit=50", undefined, toolHeaders(coo.id)),
      res.res,
      ctx,
    );
    expect(res.status).toBe(200);
    const row = (res.body.workItems as Array<Record<string, unknown>>).find((entry) => entry.id === item.id);
    expect(row).toMatchObject({ id: item.id, status: "in_review", attentionLane: "manager" });
  });
});
