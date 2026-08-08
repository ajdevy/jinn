import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";

/**
 * Contract for the per-domain router seam (`cron-api.ts`, `org-api.ts`,
 * `experiments-api.ts`). Every moved route is driven through handleApiRequest — the
 * delegation, not the module — and pinned exactly to what it returned while inline.
 * Those assertions are green on the pre-move commit too, by design: byte-identical
 * responses either side of the move is the claim. What is new is the seam, and each
 * of its properties goes red when broken — the authority gate fires before
 * delegating, an adjacent unmatched path falls through, and a throw inside a module
 * still lands in api.ts's 500 envelope.
 *
 * This file owns the seam itself plus the `/api/experiments*` payloads. The cron and
 * org payloads moved to cron-router-contract.test.ts and org-router-contract.test.ts
 * when the third router pushed this file past the size ratchet; the rig all three
 * share is domain-router-harness.ts, over the temp home in domain-router-home.ts.
 */

/** Set by the tests that need a delegated handler to blow up mid-request. */
let cronRunsThrows = false;
let experimentStoreThrows = false;

vi.mock("../../shared/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/paths.js")>();
  const { home } = await import("./domain-router-home.js");
  return {
    ...actual,
    get CRON_RUNS() {
      if (cronRunsThrows) throw new Error("forced cron paths failure");
      return home.cronRuns;
    },
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

// Experiments live in SQLite rather than on disk, so the forced failure is on the
// store call instead of on a path. Everything else is the real store against the
// temp home vitest.global-setup.ts pins JINN_HOME to.
vi.mock("../../experiments/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../experiments/store.js")>();
  return {
    ...actual,
    listExperiments: (...args: Parameters<typeof actual.listExperiments>) => {
      if (experimentStoreThrows) throw new Error("forced experiment store failure");
      return actual.listExperiments(...args);
    },
  };
});

import { JOBS, home, seedHome } from "./domain-router-home.js";
import { RUN, call, createExperiment, runningExperiment } from "./domain-router-harness.js";

beforeEach(() => {
  cronRunsThrows = false;
  experimentStoreThrows = false;
  runCronJob.mockClear();
  seedHome();
});

describe("experiment routes still answer identically through handleExperimentsApi", () => {
  it("POST /api/experiments returns the created experiment (201) and 400s a missing field", async () => {
    const experiment = await createExperiment();
    expect(experiment.id).toMatch(/^exp_[0-9a-f]{12}$/);
    expect(Number.isNaN(Date.parse(experiment.startedAt))).toBe(false);
    expect(experiment).toEqual(runningExperiment(experiment.id, experiment.startedAt));

    const bad = await call("POST", "/api/experiments", { ...RUN, hypothesis: undefined });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: "hypothesis is required and must be a string" });
  });

  it("GET /api/experiments lists the created experiment and filters by status", async () => {
    const experiment = await createExperiment();
    const listed = await call("GET", "/api/experiments");
    expect(listed.status).toBe(200);
    expect(listed.body.experiments.find((row: any) => row.id === experiment.id))
      .toEqual(runningExperiment(experiment.id, experiment.startedAt));

    const concluded = await call("GET", "/api/experiments?status=concluded");
    expect(concluded.status).toBe(200);
    expect(concluded.body.experiments.map((row: any) => row.id)).not.toContain(experiment.id);

    const bogus = await call("GET", "/api/experiments?status=maybe");
    expect(bogus.status).toBe(400);
    expect(bogus.body).toEqual({ error: "status must be running or concluded" });
  });

  it("GET /api/experiments/:id returns the one experiment, and 404s an unknown id", async () => {
    const experiment = await createExperiment();
    const found = await call("GET", `/api/experiments/${experiment.id}`);
    expect(found.status).toBe(200);
    expect(found.body).toEqual({ experiment: runningExperiment(experiment.id, experiment.startedAt) });

    const missing = await call("GET", "/api/experiments/exp_000000000000");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'experiment "exp_000000000000" was not found' });
  });

  it("PATCH /api/experiments/:id applies the edit, and 400s a metric without a baseline", async () => {
    const experiment = await createExperiment();
    const metrics = [...RUN.metrics, { name: "retention", unit: "%", howToMeasure: "Read the day-seven cohort." }];

    const updated = await call("PATCH", `/api/experiments/${experiment.id}`, {
      name: "Even shorter onboarding",
      metrics,
      baseline: { retention: 22 },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toEqual({
      experiment: runningExperiment(experiment.id, experiment.startedAt, {
        name: "Even shorter onboarding",
        metrics,
        baseline: { activation: 40, retention: 22 },
      }),
    });

    const unbacked = await call("PATCH", `/api/experiments/${experiment.id}`, {
      metrics: [...metrics, { name: "referrals", howToMeasure: "Count invites sent." }],
    });
    expect(unbacked.status).toBe(400);
    expect(unbacked.body).toEqual({ error: 'baseline must include a finite number for metric "referrals"' });
  });

  it("POST /api/experiments/:id/readings appends a reading (201), and 400s an undeclared metric", async () => {
    const experiment = await createExperiment();
    const recorded = await call("POST", `/api/experiments/${experiment.id}/readings`, {
      at: "2026-08-08T09:00:00.000Z",
      metric: "activation",
      value: 46,
      note: "First week.",
    });
    expect(recorded.status).toBe(201);
    expect(recorded.body).toEqual({
      reading: {
        id: recorded.body.reading.id,
        experimentId: experiment.id,
        at: "2026-08-08T09:00:00.000Z",
        metric: "activation",
        value: 46,
        note: "First week.",
      },
    });
    expect(recorded.body.reading.id).toMatch(/^rd_[0-9a-f]{12}$/);

    const undeclared = await call("POST", `/api/experiments/${experiment.id}/readings`, {
      at: "2026-08-08T09:00:00.000Z",
      metric: "churn",
      value: 1,
    });
    expect(undeclared.status).toBe(400);
    expect(undeclared.body).toEqual({ error: 'metric "churn" is not declared on this experiment' });
  });

  it("POST /api/experiments/:id/conclude records the verdict, and 409s a second attempt", async () => {
    const experiment = await createExperiment();
    const concluded = await call("POST", `/api/experiments/${experiment.id}/conclude`, {
      outcome: "win",
      note: "Activation rose six points.",
    });
    expect(concluded.status).toBe(200);
    expect(concluded.body).toEqual({
      experiment: runningExperiment(experiment.id, experiment.startedAt, {
        status: "concluded",
        verdict: {
          outcome: "win",
          note: "Activation rose six points.",
          concludedAt: concluded.body.experiment.verdict.concludedAt,
        },
      }),
    });

    const again = await call("POST", `/api/experiments/${experiment.id}/conclude`, { outcome: "loss", note: "Again." });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "experiment is already concluded" });
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
    expect(JSON.parse(fs.readFileSync(home.cronJobs, "utf-8"))).toEqual(JOBS);
  });

  it("refuses an unidentified experiment write before delegating, though it is not operator-only", async () => {
    // Experiments are deliberately absent from the operator-only table — any
    // identified caller may run one. What has to survive the move is the order:
    // the caller-identity gate answers first, so the module never sees the write.
    const refused = await call("POST", "/api/experiments", { ...RUN, name: "Unidentified caller" }, {});
    expect(refused.status).toBe(403);

    const names = (await call("GET", "/api/experiments")).body.experiments.map((row: any) => row.name);
    expect(names).not.toContain("Unidentified caller");
  });

  it("falls through on an adjacent unmatched path instead of swallowing it", async () => {
    const r = await call("GET", "/api/cronx");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "Not found" });

    const orgish = await call("GET", "/api/orgx");
    expect(orgish.status).toBe(404);

    const experimental = await call("GET", "/api/experimentsx");
    expect(experimental.status).toBe(404);
  });

  it("lets a throw inside a delegated module reach api.ts's 500 envelope", async () => {
    cronRunsThrows = true;
    const r = await call("GET", "/api/cron");
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "forced cron paths failure" });

    experimentStoreThrows = true;
    const experimental = await call("GET", "/api/experiments");
    expect(experimental.status).toBe(500);
    expect(experimental.body).toEqual({ error: "forced experiment store failure" });
  });
});
