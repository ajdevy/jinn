import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleApiRequest, type ApiContext } from "../api.js";

/**
 * A round is a whole child run, so the run detail an operator reads has to keep
 * round k apart from round k+1 — its own status, its own output, its own run to
 * open — rather than reporting one collapsed result for the node.
 */

function request(url: string) {
  const req = Readable.from([]);
  Object.assign(req, { method: "GET", url,
    headers: { host: "localhost", authorization: "Bearer test-token", "content-type": "application/json" } });
  return req as unknown as Parameters<typeof handleApiRequest>[0];
}

function response() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    setHeader: vi.fn(),
    writeHead(code: number) { status = code; return this; },
    write(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)); return true; },
    end(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)); },
  } as unknown as ServerResponse;
  return { res, read: () => ({ status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> }) };
}

const runId = "run_11111111-1111-4111-8111-111111111111";

function round(index: number, status: string, verdict: string, sessionRun: string) {
  return { runId: sessionRun, workflowId: "body-flow", nodeId: "loop", itemIndex: index, status,
    startedAt: `2026-08-20T12:0${index}:00.000Z`, endedAt: `2026-08-20T12:0${index}:30.000Z`, endOutput: { verdict } };
}

describe("GET /api/workflows/:id/runs/:runId for an iterating call", () => {
  it("carries every round as its own record, and the node's round count with it", async () => {
    const detail = {
      id: runId, workflowId: "loop-flow", workflowTitle: "Rework", definitionRevision: 1, revision: 9,
      definition: { nodes: [], edges: [] }, input: {}, trigger: { nodeId: "start", kind: "manual", payload: {} },
      status: "completed", startedAt: "2026-08-20T12:00:00.000Z", endedAt: "2026-08-20T12:09:00.000Z",
      nodeRuns: [{ runId, nodeId: "loop", nodeType: "workflow-call", status: "completed", activated: true,
        resolvedConfig: { workflowId: "body-flow", round: 2, maxRounds: 2 },
        output: { text: "", fields: { round: 2, maxRounds: 2, port: "exhausted", exhausted: true,
          last: { verdict: "rework" },
          rounds: [{ round: 1, runId: "body-1", workflowId: "body-flow", status: "succeeded", fields: { verdict: "rework" } },
            { round: 2, runId: "body-2", workflowId: "body-flow", status: "succeeded", fields: { verdict: "rework" } }] } } }],
      attempts: [], approvals: [],
      childRuns: [round(0, "completed", "rework", "body-1"), round(1, "completed", "rework", "body-2")],
    };
    const context = {
      gatewayAuthToken: "test-token",
      workflowService: { getRun: vi.fn(() => detail), getRunSpend: vi.fn(() => 0) },
      getConfig: () => ({ gateway: {}, engines: {} }),
      connectors: new Map(), sessionManager: { getQueue: () => ({}) }, emit: vi.fn(), startTime: 1,
    } as unknown as ApiContext;

    const lean = response();
    await handleApiRequest(request(`/api/workflows/loop-flow/runs/${runId}`), lean.res, context);
    const { status, body } = lean.read();

    expect(status).toBe(200);
    const children = body.childRuns as Array<Record<string, unknown>>;
    expect(children).toHaveLength(2);
    expect(children.map((child) => child.runId)).toEqual(["body-1", "body-2"]);
    expect(children.map((child) => child.itemIndex)).toEqual([0, 1]);
    expect(children.map((child) => child.endOutput)).toEqual([{ verdict: "rework" }, { verdict: "rework" }]);

    const loop = (body.nodeRuns as Array<Record<string, unknown>>)[0]!;
    expect(loop.output).toMatchObject({ fields: { round: 2, maxRounds: 2, port: "exhausted" } });
    expect((loop.output as { fields: { rounds: unknown[] } }).fields.rounds).toHaveLength(2);
  });
});
