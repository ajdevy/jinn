import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The `/api/cron*` half of the domain-router contract. Every moved route is driven
 * through handleApiRequest — the delegation, not the module — and pinned exactly to
 * what it returned while inline. The seam's own properties live in
 * domain-router-contract.test.ts; this file only pins the payloads.
 */

vi.mock("../../shared/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/paths.js")>();
  const { home } = await import("./domain-router-home.js");
  return {
    ...actual,
    get CRON_RUNS() { return home.cronRuns; },
    get CRON_JOBS() { return home.cronJobs; },
    get ORG_DIR() { return home.org; },
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

import { JOBS, seedHome } from "./domain-router-home.js";
import { call } from "./domain-router-harness.js";

beforeEach(() => {
  runCronJob.mockClear();
  seedHome();
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
