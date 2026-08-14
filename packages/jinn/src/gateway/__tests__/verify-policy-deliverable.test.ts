import { describe, expect, it } from "vitest";
import { api, ctx, makeReq, makeRes, operatorHeaders, reg, store, toolHeaders } from "./helpers/work-items-route-harness.js";
import { buildWorkItemTools } from "../../mcp/work-item-tools.js";
import type { JinnMcpContext, JinnMcpTool } from "../../mcp/toolkit.js";

/**
 * `verifyPolicy` is written at two boundaries — the gateway route and the MCP
 * tool layer — which until now validated it with two copies of the same rules.
 * They share one validator, and this suite is what holds them to it: the same
 * bad route has to be refused by the same named error on both sides, or the
 * declaration means one thing to an agent and another to the web UI.
 */

function mcpTool(name: string): JinnMcpTool {
  const found = buildWorkItemTools().find((tool) => tool.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

/** The MCP tools reach the gateway over fetch; this records the body instead. */
function mcpContext() {
  const sent: unknown[] = [];
  const fetchFn = (async (_input: string | URL, init?: RequestInit) => {
    sent.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
    return { status: 201, text: async () => JSON.stringify({ workItem: { id: "AAA-1" } }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return {
    sent,
    ctx: {
      // Never dialed — fetchFn below answers every request — and deliberately
      // not a real port, so nothing here can reach a live gateway.
      gatewayUrl: "http://gateway.invalid",
      fetchFn,
      callerSessionId: "session-test",
      sessionCapability: "cap-test",
    } satisfies JinnMcpContext,
  };
}

describe("a Todo declaring that its deliverable lands in the workspace", () => {
  it("round-trips through create, update and get on the gateway route", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "deliverable-caller", employee: "platform-worker" });

    const created = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", { title: "Deliver a Note", verifyPolicy: { mode: "verify", deliverable: "workspace" } }, toolHeaders(caller.id)),
      created.res,
      ctx,
    );
    expect(created.status).toBe(201);
    expect(created.body.workItem.verifyPolicy).toEqual({ mode: "verify", deliverable: "workspace" });

    const id = created.body.workItem.id;
    const read = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${id}`, undefined, toolHeaders(caller.id)), read.res, ctx);
    expect(read.status).toBe(200);
    expect(read.body.workItem.verifyPolicy).toEqual({ mode: "verify", deliverable: "workspace" });

    const updated = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${id}`, {
        expectedVersion: read.body.workItem.version,
        verifyPolicy: { mode: "thorough", deliverable: "repo" },
      }, operatorHeaders),
      updated.res,
      ctx,
    );
    expect(updated.status).toBe(200);
    expect(store.getWorkItem(id)?.verifyPolicy).toEqual({ mode: "thorough", deliverable: "repo" });
  });

  it("persists nothing new when the route is not declared", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "undeclared-caller", employee: "platform-worker" });
    const created = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", { title: "Ordinary Todo", verifyPolicy: { mode: "verify" } }, toolHeaders(caller.id)),
      created.res,
      ctx,
    );
    expect(created.status).toBe(201);
    expect(created.body.workItem.verifyPolicy).toEqual({ mode: "verify" });
  });

  it("is refused by the gateway validator when the route is one nobody implements", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "bad-route-caller", employee: "platform-worker" });
    const refused = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", { title: "Bad route", verifyPolicy: { mode: "verify", deliverable: "elsewhere" } }, toolHeaders(caller.id)),
      refused.res,
      ctx,
    );
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("verifyPolicy.deliverable must be one of repo, workspace");
  });

  it("is refused by the MCP validator with the same named error, and forwarded when it is legal", async () => {
    const bad = mcpContext();
    await expect(
      mcpTool("create_work_item").handler({ title: "Bad route", verifyPolicy: { mode: "verify", deliverable: "elsewhere" } }, bad.ctx),
    ).rejects.toThrow("verifyPolicy.deliverable must be one of repo, workspace");
    expect(bad.sent).toEqual([]);

    const good = mcpContext();
    await mcpTool("create_work_item").handler({ title: "Deliver a Note", verifyPolicy: { mode: "verify", deliverable: "workspace" } }, good.ctx);
    expect(good.sent).toEqual([{ title: "Deliver a Note", verifyPolicy: { mode: "verify", deliverable: "workspace" } }]);
  });
});
