import { describe, expect, it } from "vitest";
import { api, ctx, makeReq, makeRes, reg, store, toolHeaders } from "./helpers/work-items-route-harness.js";

describe("POST /api/work-items/:id/status — escalated parent with done child", () => {
  it("lets the COO close the parent when its child is already done", async () => {
    const parent = store.createWorkItem({ title: "Escalated parent with done child", status: "escalated" });
    store.createWorkItem({ title: "Already completed child", parentId: parent.id, status: "done" });
    const coo = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:coo-closes-escalated-parent" });
    const response = makeRes();

    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${parent.id}/status`, { status: "done", asOperator: true }, toolHeaders(coo.id)),
      response.res,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(response.body.workItem.status).toBe("done");
  });
});
