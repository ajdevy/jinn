import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { WorkflowRepositoryError } from "../../workflows/repository.js";
import { handleApiRequest, type ApiContext } from "../api.js";

/* Archiving used to be one-way. `retire` and `unretire` are now the same service
 * call with a flag, so the thing worth pinning down at the route is that the flag
 * arrives the right way round and that a refused transition keeps its status. */

function request(method: string, url: string, body?: unknown, authorized = true) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: { host: "localhost",
    ...(authorized ? { authorization: "Bearer test-token" } : {}), "content-type": "application/json" } });
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
  return { res, read: () => ({ status, body: chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
    : undefined }) };
}

function contextFor(result: () => unknown) {
  const setRetired = vi.fn(result);
  const context = { gatewayAuthToken: "test-token", workflowService: { setRetired },
    getConfig: () => ({ gateway: {}, engines: {} }), connectors: new Map(),
    sessionManager: { getQueue: () => ({}) }, emit: vi.fn(), startTime: 1 } as unknown as ApiContext;
  return { context, setRetired };
}

const unarchived = { id: "release-flow", title: "Release flow", revision: 4, enabled: false };

describe("POST /api/workflows/:id/unretire", () => {
  it("clears the retirement and answers with the reinstated definition", async () => {
    const { context, setRetired } = contextFor(() => unarchived);
    const capture = response();

    await handleApiRequest(request("POST", "/api/workflows/release-flow/unretire", { expectedRevision: 3 }), capture.res, context);

    expect(capture.read()).toEqual({ status: 200, body: unarchived });
    expect(setRetired).toHaveBeenCalledWith({
      id: "release-flow", retired: false, expectedRevision: 3,
    });
  });

  it("still sends retire the other way round", async () => {
    const { context, setRetired } = contextFor(() => unarchived);

    await handleApiRequest(request("POST", "/api/workflows/release-flow/retire", { expectedRevision: 3 }), response().res, context);

    expect(setRetired).toHaveBeenCalledWith({
      id: "release-flow", retired: true, expectedRevision: 3,
    });
  });

  it("answers a stale expected revision with 409", async () => {
    const { context } = contextFor(() => {
      throw new WorkflowRepositoryError("revision-conflict", "Workflow definition release-flow revision does not match.");
    });
    const capture = response();

    await handleApiRequest(request("POST", "/api/workflows/release-flow/unretire", { expectedRevision: 1 }), capture.res, context);

    expect(capture.read()).toMatchObject({ status: 409, body: { code: "revision-conflict" } });
  });

  it("answers a definition that is not retired with 422", async () => {
    const { context } = contextFor(() => {
      throw new WorkflowRepositoryError("bad-input", "Workflow definition release-flow is not retired.");
    });
    const capture = response();

    await handleApiRequest(request("POST", "/api/workflows/release-flow/unretire", { expectedRevision: 3 }), capture.res, context);

    expect(capture.read()).toMatchObject({ status: 422,
      body: { code: "bad-input", message: "Workflow definition release-flow is not retired." } });
  });

  it("requires an authenticated caller", async () => {
    const { context, setRetired } = contextFor(() => unarchived);
    const capture = response();

    await handleApiRequest(request("POST", "/api/workflows/release-flow/unretire", { expectedRevision: 3 }, false), capture.res, context);

    expect(capture.read().status).toBe(401);
    expect(setRetired).not.toHaveBeenCalled();
  });
});
