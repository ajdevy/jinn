import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import type { JinnConfig } from "../../shared/types.js";

/**
 * Contract for the per-domain router seam (`cron-api.ts`, `org-api.ts`). Every moved
 * route is driven through handleApiRequest — the delegation, not the module — and
 * pinned exactly to what it returned while inline. Those assertions are green on the
 * pre-move commit too, by design: byte-identical responses either side of the move is
 * the claim. What is new is the seam, and each of its properties goes red when broken
 * — the operator gate fires before delegating, an adjacent unmatched path falls
 * through, and a throw inside a module still lands in api.ts's 500 envelope.
 */

const bootHome = fs.mkdtempSync(path.join(os.tmpdir(), "domain-router-boot-"));
let tmpHome = bootHome;
let cronRunsDir = path.join(tmpHome, "cron", "runs");
let cronJobsFile = path.join(tmpHome, "cron", "jobs.json");
let orgDir = path.join(tmpHome, "org");
/** Set by the one test that needs a delegated handler to blow up mid-request. */
let cronRunsThrows = false;

vi.mock("../../shared/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/paths.js")>();
  return {
    ...actual,
    get CRON_RUNS() {
      if (cronRunsThrows) throw new Error("forced cron paths failure");
      return cronRunsDir;
    },
    get CRON_JOBS() { return cronJobsFile; },
    get ORG_DIR() { return orgDir; },
  };
});

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The two cron side effects that reach outside the request: rescheduling and
// actually firing a job.
vi.mock("../../cron/scheduler.js", () => ({ reloadScheduler: vi.fn() }));
const runCronJob = vi.fn(async () => {});
vi.mock("../../cron/runner.js", () => ({ runCronJob: (...args: unknown[]) => runCronJob(...(args as [])) }));

import { handleApiRequest } from "../api.js";
import type { ApiContext } from "../api.js";

const MODELS = [
  { id: "gpt-5.6-sol", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
  { id: "gpt-5.5", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
];

const context = {
  getConfig: () => ({
    gateway: {},
    engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.6-sol" } },
    models: { codex: { default: "gpt-5.6-sol", models: MODELS } },
    connectors: {},
    mcp: {},
  } as unknown as JinnConfig),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  reloadOrg: () => {},
  sessionManager: {
    getEngine: () => undefined,
    getEngines: () => new Map(),
    getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_k: string, s: string) => s }),
  },
} as unknown as ApiContext;

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(next: number) { status = next; return this; },
    setHeader() { return this; },
    end(chunk?: Buffer | string) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body(): any {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return undefined;
      try { return JSON.parse(raw); } catch { return raw; }
    },
  };
}

/** Operator caller by default; pass `{}` for headers to drop operator authority. */
async function call(method: string, url: string, body?: unknown, headers?: Record<string, string>) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    url,
    headers: { host: "localhost", "content-type": "application/json", ...(headers ?? { authorization: "Bearer test-token" }) },
    socket: { remoteAddress: "127.0.0.1" },
  });
  const cap = makeRes();
  await handleApiRequest(req as unknown as Parameters<typeof handleApiRequest>[0], cap.res, context);
  return { status: cap.status, body: cap.body };
}

const JOBS = [
  { id: "nightly", name: "Nightly", enabled: true, schedule: "0 3 * * *", employee: "ops", prompt: "Run." },
];

// The fixture org, spelled out so every field the org routes return is pinned: the
// authored employee, its persona and edges, and the system employee every org carries.
const WORKER = { name: "worker", displayName: "Worker", department: "platform", rank: "employee", engine: "codex", model: "gpt-5.6-sol", alwaysNotify: true };
const PERSONA = "Does platform work.";
const EDGES = { parentName: null, directReports: [], depth: 0, chain: ["worker"] };
const DISPATCHER = { name: "todo-dispatcher", displayName: "Todo Dispatcher", department: "system", rank: "senior", emoji: "🧭", jinnMcp: true, system: true, engine: "codex", model: "gpt-5.6-sol", alwaysNotify: true, role: "Todo Dispatcher, a system employee that starts tracked Todo work", parentName: null, directReports: [], depth: 0, chain: ["todo-dispatcher"] };

beforeEach(() => {
  cronRunsThrows = false;
  runCronJob.mockClear();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "domain-router-"));
  cronRunsDir = path.join(tmpHome, "cron", "runs");
  cronJobsFile = path.join(tmpHome, "cron", "jobs.json");
  orgDir = path.join(tmpHome, "org");
  fs.mkdirSync(cronRunsDir, { recursive: true });
  fs.mkdirSync(path.join(orgDir, "platform"), { recursive: true });
  fs.writeFileSync(cronJobsFile, JSON.stringify(JOBS));
  fs.writeFileSync(
    path.join(cronRunsDir, "nightly.jsonl"),
    JSON.stringify({ timestamp: "2026-08-01T03:00:00.000Z", status: "success", result: "ok" }) + "\n",
  );
  fs.writeFileSync(
    path.join(orgDir, "platform", "worker.yaml"),
    `name: ${WORKER.name}\ndisplayName: ${WORKER.displayName}\ndepartment: ${WORKER.department}\nrank: ${WORKER.rank}\nengine: ${WORKER.engine}\nmodel: ${WORKER.model}\npersona: ${PERSONA}\n`,
  );
  fs.writeFileSync(path.join(orgDir, "platform", "board.json"), JSON.stringify({ todo: ["ship it"] }));
});

describe("cron routes still answer identically through handleCronApi", () => {
  it("GET /api/cron returns the enriched summary list", async () => {
    const r = await call("GET", "/api/cron");
    expect(r.status).toBe(200);
    expect(r.body).toEqual([
      {
        id: "nightly",
        name: "Nightly",
        schedule: "0 3 * * *",
        enabled: true,
        employee: "ops",
        engine: null,
        timezone: null,
        lastRun: { timestamp: "2026-08-01T03:00:00.000Z", status: "success" },
      },
    ]);
  });

  it("GET /api/cron/:id/runs returns the summarized run tail", async () => {
    const r = await call("GET", "/api/cron/nightly/runs?limit=10");
    expect(r.status).toBe(200);
    expect(r.body).toEqual([{ timestamp: "2026-08-01T03:00:00.000Z", status: "success" }]);
  });

  it("POST /api/cron creates a job (201) and rejects a duplicate id (400)", async () => {
    const created = await call("POST", "/api/cron", { id: "weekly", name: "Weekly", schedule: "0 4 * * 1" });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: "weekly", name: "Weekly", enabled: true, schedule: "0 4 * * 1", prompt: "" });

    const dupe = await call("POST", "/api/cron", { id: "weekly", name: "Weekly again", schedule: "0 5 * * 1" });
    expect(dupe.status).toBe(400);
    expect(dupe.body).toEqual({ error: 'a cron job with id "weekly" already exists' });
  });

  it("PUT /api/cron/:id merges the update, and 404s an unknown id", async () => {
    const r = await call("PUT", "/api/cron/nightly", { enabled: false });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ...JOBS[0], enabled: false });

    const missing = await call("PUT", "/api/cron/ghost", { enabled: false });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "Not found" });
  });

  it("DELETE /api/cron/:id removes the job, and 404s an unknown id", async () => {
    const r = await call("DELETE", "/api/cron/nightly");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ deleted: "nightly", name: "Nightly" });
    expect((await call("DELETE", "/api/cron/nightly")).status).toBe(404);
  });

  it("POST /api/cron/:id/trigger fires the job in the background and 404s an unknown id", async () => {
    const r = await call("POST", "/api/cron/nightly/trigger", {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      triggered: true,
      jobId: "nightly",
      name: "Nightly",
      employee: "ops",
      message: 'Cron job "Nightly" triggered manually',
    });
    expect(runCronJob).toHaveBeenCalledTimes(1);

    expect((await call("POST", "/api/cron/ghost/trigger", {})).status).toBe(404);
  });
});

describe("org routes still answer identically through handleOrgApi", () => {
  it("GET /api/org returns departments, employees and hierarchy", async () => {
    const r = await call("GET", "/api/org");
    expect(r.status).toBe(200);
    // persona is replaced by the compact role on this surface; the exact match proves it.
    expect(r.body).toEqual({
      departments: ["platform"],
      employees: [{ ...WORKER, role: "Does platform work", ...EDGES }, DISPATCHER],
      hierarchy: { root: null, sorted: ["worker", "todo-dispatcher"], warnings: [] },
    });
  });

  it("GET /api/org/employees/:name returns the employee with its hierarchy edges, 404 for unknown", async () => {
    const r = await call("GET", "/api/org/employees/worker");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ...WORKER, persona: PERSONA, ...EDGES });

    const missing = await call("GET", "/api/org/employees/ghost");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "Not found" });
  });

  it("PATCH /api/org/employees/:name persists a valid field and 400s an invalid one", async () => {
    const ok = await call("PATCH", "/api/org/employees/worker", { model: "gpt-5.5" });
    expect(ok.status).toBe(200);
    // The persisted employee comes back whole; the compact role is list-only.
    expect(ok.body).toEqual({ status: "ok", employee: { ...WORKER, model: "gpt-5.5", persona: PERSONA } });

    const bad = await call("PATCH", "/api/org/employees/worker", { rank: "boss" });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'invalid rank "boss" (valid: executive, manager, senior, employee)' });

    const missing = await call("PATCH", "/api/org/employees/ghost", { model: "gpt-5.5" });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "Not found" });
  });

  it("GET /api/org/departments/:name/board returns the board, 404 when absent", async () => {
    const r = await call("GET", "/api/org/departments/platform/board");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ todo: ["ship it"] });

    expect((await call("GET", "/api/org/departments/ghost/board")).status).toBe(404);
  });

  it("PUT /api/org/departments/:name/board writes the board, 404 for an unknown department", async () => {
    const r = await call("PUT", "/api/org/departments/platform/board", { todo: ["rewritten"] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "ok" });
    expect(JSON.parse(fs.readFileSync(path.join(orgDir, "platform", "board.json"), "utf-8"))).toEqual({
      todo: ["rewritten"],
    });

    expect((await call("PUT", "/api/org/departments/ghost/board", { todo: [] })).status).toBe(404);
  });
});

describe("the seam itself", () => {
  it("still runs the operator-only control-plane gate before delegating", async () => {
    const gated = [
      { method: "POST", url: "/api/cron", body: { id: "sneaky", name: "Sneaky", schedule: "* * * * *" } },
      { method: "PUT", url: "/api/cron/nightly", body: { enabled: false } },
      { method: "DELETE", url: "/api/cron/nightly", body: undefined },
      { method: "POST", url: "/api/cron/nightly/trigger", body: {} },
      { method: "PATCH", url: "/api/org/employees/worker", body: { model: "gpt-5.5" } },
      { method: "PUT", url: "/api/org/departments/platform/board", body: { todo: [] } },
    ];
    for (const route of gated) {
      const r = await call(route.method, route.url, route.body, {});
      expect(`${route.method} ${route.url} → ${r.status}`).toBe(`${route.method} ${route.url} → 403`);
    }
    // The gate ran instead of the handler: nothing was scheduled, nothing fired.
    expect(runCronJob).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(cronJobsFile, "utf-8"))).toEqual(JOBS);
  });

  it("falls through on an adjacent unmatched path instead of swallowing it", async () => {
    const r = await call("GET", "/api/cronx");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "Not found" });

    const orgish = await call("GET", "/api/orgx");
    expect(orgish.status).toBe(404);
  });

  it("lets a throw inside a delegated module reach api.ts's 500 envelope", async () => {
    cronRunsThrows = true;
    const r = await call("GET", "/api/cron");
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "forced cron paths failure" });
  });
});
