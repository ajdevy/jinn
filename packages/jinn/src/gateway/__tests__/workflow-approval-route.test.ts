import { describe, expect, it, vi } from "vitest";
import { WorkflowRepositoryError } from "../../workflows/repository.js";
import { WorkflowServiceError } from "../../workflows/service.js";
import { handleApiRequest, type ApiContext } from "../api.js";
import { request, response } from "./workflow-api-harness.js";

/* The approval route: what it accepts, what it refuses before the service ever
 * sees it, and what it has to hand back in the service's words rather than its
 * own generic one. */

const ROUTE = "/api/workflows/release-flow/runs/run_11111111-1111-4111-8111-111111111111/nodes/review/approval";

function approvalContext(decideApproval: ReturnType<typeof vi.fn>): ApiContext {
  return { gatewayAuthToken: "test-token", workflowService: { decideApproval },
    getConfig: () => ({ gateway: {}, engines: {} }), connectors: new Map(),
    sessionManager: { getQueue: () => ({}) }, emit: vi.fn(), startTime: 1 } as unknown as ApiContext;
}

describe("the Workflow approval route", () => {
  it("rejects approval actor spoofing before the service and maps approval authority/conflict errors", async () => {
    const decideApproval = vi.fn();
    const context = approvalContext(decideApproval);
    const spoof = response();
    await handleApiRequest(request("POST", ROUTE, { decision: "approve", decidedBy: "spoofed", expectedRevision: 1 }), spoof.res, context);
    expect(spoof.read()).toEqual({ status: 422, body: { code: "bad-input", message: "Workflow request is invalid." } });
    expect(decideApproval).not.toHaveBeenCalled();

    for (const [code, status] of [["forbidden", 403], ["conflict", 409]] as const) {
      decideApproval.mockRejectedValueOnce(new WorkflowServiceError(code, `${code} decision`));
      const capture = response();
      await handleApiRequest(request("POST", ROUTE, { decision: "reject", expectedRevision: 1 }), capture.res, context);
      expect(capture.read()).toEqual({ status, body: { code, message: `${code} decision` } });
    }
  });

  it("forwards an approval choice and lets the service own every choice refusal", async () => {
    const decideApproval = vi.fn(async () => ({ id: "run_11111111-1111-4111-8111-111111111111" }));
    const context = approvalContext(decideApproval);
    const picked = response();
    await handleApiRequest(request("POST", ROUTE, { decision: "approve", choice: "variant-b", reason: "Cheapest", expectedRevision: 4 }),
      picked.res, context);
    expect(picked.read().status).toBe(200);
    expect(decideApproval).toHaveBeenCalledWith({ workflowId: "release-flow",
      runId: "run_11111111-1111-4111-8111-111111111111", nodeId: "review", decision: "approve",
      reason: "Cheapest", choice: "variant-b", expectedRevision: 4, decidedBy: "operator" });

    // Which choices are legal is the gate's business, not the route's: a
    // non-offered pick and a pick on a rejection have to come back in the
    // service's own words, or the caller is told "request is invalid" about a
    // request whose shape was fine.
    for (const body of [{ decision: "approve", choice: "variant-z", expectedRevision: 4 },
      { decision: "reject", choice: "variant-a", expectedRevision: 4 }]) {
      decideApproval.mockRejectedValueOnce(new WorkflowRepositoryError("bad-input", "Workflow approval review does not offer that choice."));
      const capture = response();
      await handleApiRequest(request("POST", ROUTE, body), capture.res, context);
      expect(capture.read()).toEqual({ status: 422, body: { code: "bad-input",
        message: "Workflow approval review does not offer that choice." } });
    }
  });
});
