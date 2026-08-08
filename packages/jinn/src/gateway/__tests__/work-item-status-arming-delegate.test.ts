import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";

/**
 * `workflows.armingDelegates` on POST /api/work-items/:id/status: an employee
 * named in the list moves a Todo to `assigned` AS ITSELF and the audit event
 * gains an `armedAsDelegate` stamp, which is what an operator-filtered
 * `todo-status` trigger reads. The recorded actor stays the session — the
 * delegation is a fact written beside the actor, never a rewrite of it.
 *
 * It buys arming and nothing else, so the negatives here carry as much weight
 * as the positive: every other status, every other route, and every caller
 * outside the list behaves exactly as it did before the list existed.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-arming-delegate-"));
process.env.JINN_HOME = tmp;
fs.mkdirSync(path.join(tmp, "org"), { recursive: true });
fs.writeFileSync(
  path.join(tmp, "org", "platform-delegate.yaml"),
  "name: platform-delegate\ndisplayName: Platform Delegate\ndepartment: platform\nrank: employee\nengine: codex\nmodel: default\npersona: Generic route-test delegate.\n",
);
fs.writeFileSync(
  path.join(tmp, "org", "platform-worker.yaml"),
  "name: platform-worker\ndisplayName: Platform Worker\ndepartment: platform\nrank: employee\nengine: codex\nmodel: default\npersona: Generic route-test worker.\n",
);

type Api = typeof import("../api.js");
type Reg = typeof import("../../sessions/registry.js");
type Store = typeof import("../../work-items/store.js");
type Feed = typeof import("../../work-items/workflow-event-feed.js");
let api: Api;
let reg: Reg;
let store: Store;
let feed: Feed;

/** The live list, re-read by the route on every request — which is what makes
 *  a config edit take effect without a restart. */
let armingDelegates: string[] | undefined;

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    setHeader() {
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
  };
}

function makeReq(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
  const payload = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  return Object.assign(Readable.from(payload), {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
}

const ctx = {
  getConfig: () => ({
    gateway: {},
    engines: {},
    ...(armingDelegates === undefined ? {} : { workflows: { armingDelegates } }),
  }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => undefined,
  workflowService: { getRun: () => null },
  sessionManager: {
    getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_key: string, status: string) => status }),
  },
} as unknown as import("../api.js").ApiContext;

function toolHeaders(sessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

async function post(urlPath: string, body: Record<string, unknown>, headers: Record<string, string>) {
  const cap = makeRes();
  await api.handleApiRequest(makeReq("POST", urlPath, body, headers), cap.res, ctx);
  return cap;
}

function setStatus(id: string, body: Record<string, unknown>, headers: Record<string, string>) {
  return post(`/api/work-items/${id}/status`, body, headers);
}

function session(employee: string, ref: string): string {
  return reg.createSession({ engine: "codex", source: "web", sourceRef: ref, employee }).id;
}

function lastDetail(id: string): Record<string, unknown> {
  return (store.listWorkItemEvents(id).at(-1)?.detail ?? {}) as Record<string, unknown>;
}

beforeAll(async () => {
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  feed = await import("../../work-items/workflow-event-feed.js");
  (await import("../../shared/db.js")).initDb();
  armingDelegates = ["platform-delegate"];
});

describe("POST /api/work-items/:id/status — arming delegates", () => {
  it("stamps a listed delegate's own arming move while the event still names the session", async () => {
    const item = store.createWorkItem({ title: "Arm the pipeline", status: "backlog" });
    const delegate = session("platform-delegate", "web:delegate-arms");

    const cap = await setStatus(item.id, { status: "assigned" }, toolHeaders(delegate));

    expect([cap.status, cap.body.workItem.status]).toEqual([200, "assigned"]);
    expect(store.listWorkItemEvents(item.id).at(-1)).toMatchObject({
      toStatus: "assigned",
      actor: `session:${delegate}`,
      detail: { armedAsDelegate: "platform-delegate" },
    });
    expect(feed.createWorkflowTodoEventFeed().listPendingEvents(500)).toContainEqual(
      expect.objectContaining({ workItemId: item.id, actor: `session:${delegate}`, armedAsDelegate: "platform-delegate" }),
    );
  });

  it("leaves an employee outside the list unstamped", async () => {
    const item = store.createWorkItem({ title: "Not delegated", status: "backlog" });

    const cap = await setStatus(item.id, { status: "assigned" }, toolHeaders(session("platform-worker", "web:worker-arms")));

    expect([cap.status, cap.body.workItem.status]).toEqual([200, "assigned"]);
    expect(lastDetail(item.id)).not.toHaveProperty("armedAsDelegate");
  });

  it("writes no stamp when the list is empty or absent", async () => {
    const delegate = session("platform-delegate", "web:delegate-no-list");

    for (const list of [[], undefined]) {
      armingDelegates = list;
      const item = store.createWorkItem({ title: "Nothing configured", status: "backlog" });
      const cap = await setStatus(item.id, { status: "assigned" }, toolHeaders(delegate));

      expect([cap.status, cap.body.workItem.status]).toEqual([200, "assigned"]);
      expect(lastDetail(item.id)).not.toHaveProperty("armedAsDelegate");
    }
    armingDelegates = ["platform-delegate"];
  });

  it("picks up a list change on the next move, with no restart in between", async () => {
    const delegate = session("platform-delegate", "web:delegate-hot-reload");
    const stamped = () => {
      const item = store.createWorkItem({ title: "Hot reload", status: "backlog" });
      return setStatus(item.id, { status: "assigned" }, toolHeaders(delegate))
        .then(() => Object.prototype.hasOwnProperty.call(lastDetail(item.id), "armedAsDelegate"));
    };

    armingDelegates = ["someone-else"];
    expect(await stamped()).toBe(false);

    armingDelegates = ["someone-else", "platform-delegate"];
    expect(await stamped()).toBe(true);

    armingDelegates = ["someone-else"];
    expect(await stamped()).toBe(false);

    armingDelegates = ["platform-delegate"];
  });

  it("stamps the arming move only, not any other status the delegate can reach", async () => {
    const delegate = session("platform-delegate", "web:delegate-other-statuses");

    for (const [status, extra] of [["executing", {}], ["in_review", {}], ["blocked", { note: "waiting" }]] as const) {
      const item = store.createWorkItem({ title: `Move to ${status}`, status: "backlog" });
      const cap = await setStatus(item.id, { status, ...extra }, toolHeaders(delegate));

      expect([cap.status, cap.body.workItem.status]).toEqual([200, status]);
      expect(lastDetail(item.id)).not.toHaveProperty("armedAsDelegate");
    }
  });

  it("ignores an armedAsDelegate the caller wrote into the request body", async () => {
    const worker = session("platform-worker", "web:worker-forges");
    const delegate = session("platform-delegate", "web:delegate-forges");

    const forged = store.createWorkItem({ title: "Forged claim", status: "backlog" });
    const cap = await setStatus(
      forged.id,
      { status: "assigned", armedAsDelegate: "platform-delegate", detail: { armedAsDelegate: "platform-delegate" } },
      toolHeaders(worker),
    );
    expect(cap.status).toBe(200);
    expect(lastDetail(forged.id)).not.toHaveProperty("armedAsDelegate");

    // A delegate cannot name someone else either: the stamp is read off the
    // session's own employee, so the body is never a source of the name.
    const renamed = store.createWorkItem({ title: "Renamed claim", status: "backlog" });
    await setStatus(renamed.id, { status: "assigned", armedAsDelegate: "platform-worker" }, toolHeaders(delegate));
    expect(lastDetail(renamed.id)).toMatchObject({ armedAsDelegate: "platform-delegate" });
  });

  it("grants nothing but arming: asOperator, cancel, and an operator-only approval stay refused", async () => {
    const delegate = session("platform-delegate", "web:delegate-reaches");

    const claiming = store.createWorkItem({ title: "Claim the operator", status: "backlog" });
    const asOperator = await setStatus(claiming.id, { status: "assigned", asOperator: true }, toolHeaders(delegate));
    expect(asOperator.status).toBe(403);
    expect(asOperator.body.error).toMatch(/employee "platform-delegate" must transition as itself/);
    expect(store.getWorkItem(claiming.id)?.status).toBe("backlog");

    const live = store.createWorkItem({ title: "Cancel attempt", status: "executing" });
    const cancelled = await setStatus(live.id, { status: "cancelled" }, toolHeaders(delegate));
    expect(cancelled.status).toBe(403);
    expect(cancelled.body.error).toMatch(/cancelling a Todo is a human surface decision/);
    expect(store.getWorkItem(live.id)?.status).toBe("executing");

    const gated = store.createWorkItem({
      title: "Reserved gate", status: "in_review", assignee: "platform-delegate", department: "platform",
    });
    const requested = await post(
      `/api/work-items/${gated.id}/approval/request`,
      { request: "Ship it?", operatorOnly: true },
      toolHeaders(delegate),
    );
    expect(requested.status).toBe(200);
    const decided = await post(`/api/work-items/${gated.id}/approval`, { decision: "approve" }, toolHeaders(delegate));
    expect(decided.status).toBe(403);
    expect(store.getWorkItem(gated.id)?.approvalState).toBe("pending");
  });
});
