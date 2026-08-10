import { beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-experiments-store-"));
process.env.JINN_HOME = home;

type Store = typeof import("../store.js");
let store: Store;
let db: import("better-sqlite3").Database;
let createWorkItem: typeof import("../../work-items/store.js").createWorkItem;

const metrics = [
  { name: "activation", unit: "%", howToMeasure: "Read the activation dashboard." },
  { name: "retention", unit: "%", howToMeasure: "Read the day-seven cohort." },
];

beforeAll(async () => {
  store = await import("../store.js");
  db = (await import("../../shared/db.js")).initDb();
  ({ createWorkItem } = await import("../../work-items/store.js"));
});

function attemptCreate(name: string, extra: Partial<import("../store.js").CreateExperimentInput> = {}) {
  return store.createExperiment({
    name,
    hypothesis: "A smaller first step will improve activation.",
    baseline: { activation: 21, retention: 38 },
    metrics,
    horizonDays: 30,
    ...extra,
  });
}

function createFixture(name: string, extra: Partial<import("../store.js").CreateExperimentInput> = {}) {
  const result = attemptCreate(name, extra);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.detail);
  return result.value;
}

describe("experiment store", () => {
  it("creates the experiment tables during database initialization", () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'experiment%' ORDER BY name",
    ).pluck().all();

    expect(tables).toEqual(["experiment_metrics", "experiment_readings", "experiments"]);
  });

  it("creates a running experiment and returns its declared metrics", () => {
    const experiment = createFixture("Onboarding clarity");

    expect(experiment).toMatchObject({
      id: expect.stringMatching(/^exp_[0-9a-f]{12}$/),
      name: "Onboarding clarity",
      status: "running",
      horizonDays: 30,
      metrics,
      readings: [],
    });
    expect(store.getExperiment(experiment.id)).toEqual({ ok: true, value: experiment });
  });

  it("appends readings, rejects undeclared metrics, and returns readings chronologically", () => {
    const experiment = createFixture("Reading order");

    const later = store.recordReading(experiment.id, {
      at: "2026-08-03T12:00:00.000Z",
      metric: "activation",
      value: 25,
      note: "Second check-in",
    });
    const earlier = store.recordReading(experiment.id, {
      at: "2026-08-01T12:00:00.000Z",
      metric: "activation",
      value: 23,
    });
    const invalid = store.recordReading(experiment.id, {
      at: "2026-08-02T12:00:00.000Z",
      metric: "undeclared",
      value: 99,
    });

    expect(later).toMatchObject({ ok: true, value: { metric: "activation", value: 25, note: "Second check-in" } });
    expect(earlier).toMatchObject({ ok: true, value: { metric: "activation", value: 23 } });
    expect(invalid).toMatchObject({ ok: false, reason: "invalid" });
    const fetched = store.getExperiment(experiment.id);
    expect(fetched.ok).toBe(true);
    if (fetched.ok) {
      expect(fetched.value.readings.map((reading) => reading.at)).toEqual([
        "2026-08-01T12:00:00.000Z",
        "2026-08-03T12:00:00.000Z",
      ]);
    }
    expect("updateReading" in store).toBe(false);
    expect("deleteReading" in store).toBe(false);
  });

  it("edits the allowed fields while running and preserves the baseline", () => {
    const experiment = createFixture("Editable experiment");
    const updated = store.updateExperiment(experiment.id, {
      name: "Edited experiment",
      hypothesis: "The revised prompt will improve activation.",
      horizonDays: 45,
      metrics: [
        ...metrics,
        { name: "completion", howToMeasure: "Read completed onboarding sessions." },
      ],
      baseline: { completion: 12 },
    });

    expect(updated).toMatchObject({
      ok: true,
      value: {
        name: "Edited experiment",
        hypothesis: "The revised prompt will improve activation.",
        horizonDays: 45,
        baseline: { activation: 21, retention: 38, completion: 12 },
        metrics: [
          ...metrics,
          { name: "completion", howToMeasure: "Read completed onboarding sessions." },
        ],
      },
    });
  });

  it("refuses a metric added without a baseline value and names it", () => {
    const experiment = createFixture("Baseline-less metric");

    const updated = store.updateExperiment(experiment.id, {
      metrics: [...metrics, { name: "completion", howToMeasure: "Read completed onboarding sessions." }],
    });

    expect(updated).toMatchObject({ ok: false, reason: "invalid" });
    if (!updated.ok) expect(updated.detail).toContain("completion");
  });

  it("drops the baseline entry of a removed metric", () => {
    const experiment = createFixture("Shrinking metrics");

    const updated = store.updateExperiment(experiment.id, { metrics: [metrics[0]] });

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.baseline).toEqual({ activation: 21 });
    expect(updated.value.metrics).toEqual([metrics[0]]);
  });

  it("rejects a baseline for a metric the experiment does not declare", () => {
    const experiment = createFixture("Undeclared baseline");

    expect(store.updateExperiment(experiment.id, { baseline: { churn: 4 } })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("derives the horizon end and flags a running experiment past it", () => {
    const experiment = createFixture("Horizon math");
    const dayMs = 86_400_000;

    expect(Date.parse(experiment.horizonEndsAt) - Date.parse(experiment.startedAt)).toBe(30 * dayMs);
    expect(experiment.overdue).toBe(false);

    const started = "2026-01-01T00:00:00.000Z";
    const endsAt = "2026-01-31T00:00:00.000Z";
    db.prepare("UPDATE experiments SET started_at = ? WHERE id = ?").run(started, experiment.id);
    const backdated = store.getExperiment(experiment.id);
    expect(backdated.ok).toBe(true);
    if (!backdated.ok) return;
    expect(backdated.value.horizonEndsAt).toBe(endsAt);
    expect(backdated.value.overdue).toBe(true);

    // Exactly at the boundary is not yet overdue; a moment before it certainly is not.
    for (const now of [Date.parse(endsAt), Date.parse(endsAt) - 1]) {
      vi.setSystemTime(now);
      const atBoundary = store.getExperiment(experiment.id);
      expect(atBoundary.ok).toBe(true);
      if (atBoundary.ok) expect(atBoundary.value.overdue).toBe(false);
    }
    vi.useRealTimers();

    const concluded = store.concludeExperiment(experiment.id, {
      outcome: "loss",
      note: "Past its horizon and going nowhere.",
    });
    expect(concluded.ok).toBe(true);
    if (concluded.ok) expect(concluded.value.overdue).toBe(false);
  });

  it("hydrates a long list with two batch queries and the same rows getExperiment returns", () => {
    for (let index = 0; index < 30; index += 1) {
      const experiment = createFixture(`Batch ${index}`);
      store.recordReading(experiment.id, { at: "2026-08-01T12:00:00.000Z", metric: "activation", value: index });
      store.recordReading(experiment.id, { at: "2026-08-02T12:00:00.000Z", metric: "retention", value: index + 1 });
    }

    const countQueries = (limit: number) => {
      const prepare = db.prepare.bind(db);
      const statements: string[] = [];
      db.prepare = ((sql: string) => { statements.push(sql); return prepare(sql); }) as typeof db.prepare;
      try {
        return { experiments: store.listExperiments(undefined, limit), statements };
      } finally {
        db.prepare = prepare;
      }
    };

    const small = countQueries(5);
    const large = countQueries(500);

    expect(large.experiments.length).toBeGreaterThanOrEqual(30);
    expect(large.statements.length).toBe(small.statements.length);
    expect(large.statements.filter((sql) => sql.includes("FROM experiment_metrics")).length).toBe(1);
    expect(large.statements.filter((sql) => sql.includes("FROM experiment_readings")).length).toBe(1);
    for (const experiment of large.experiments) {
      expect(store.getExperiment(experiment.id)).toEqual({ ok: true, value: experiment });
    }
  });

  it("clamps the list limit rather than trusting the caller", () => {
    expect(store.listExperiments(undefined, 2)).toHaveLength(2);
    expect(store.listExperiments().length).toBeLessThanOrEqual(100);
    expect(store.listExperiments(undefined, 99_999).length).toBeLessThanOrEqual(500);
    expect(store.listExperiments(undefined, Number.NaN).length).toBeLessThanOrEqual(100);
  });

  it("links an existing Todo and an owner, and clears the link with null", () => {
    const todo = createWorkItem({ title: "Owning Todo", createdBy: "operator" });
    const experiment = createFixture("Linked experiment", { todoId: todo.id, owner: "growth-lead" });

    expect(experiment).toMatchObject({ todoId: todo.id, owner: "growth-lead" });
    expect(store.getExperiment(experiment.id)).toEqual({ ok: true, value: experiment });

    const cleared = store.updateExperiment(experiment.id, { todoId: null });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.value.todoId).toBeUndefined();
    expect(cleared.value.owner).toBe("growth-lead");
  });

  it("refuses a malformed Todo id and one that names no row", () => {
    expect(attemptCreate("Malformed link", { todoId: "nope" })).toMatchObject({ ok: false, reason: "invalid" });
    const missing = attemptCreate("Dangling link", { todoId: "ZZZ-1" });
    expect(missing).toMatchObject({ ok: false, reason: "invalid" });
    if (!missing.ok) expect(missing.detail).toContain("ZZZ-1");
  });

  it("refuses to relink a concluded experiment", () => {
    const todo = createWorkItem({ title: "Late link", createdBy: "operator" });
    const experiment = createFixture("Concluded link");
    store.concludeExperiment(experiment.id, { outcome: "loss", note: "Not worth continuing." });

    expect(store.updateExperiment(experiment.id, { todoId: todo.id })).toMatchObject({ ok: false, reason: "conflict" });
    expect(store.updateExperiment(experiment.id, { todoId: null })).toMatchObject({ ok: false, reason: "conflict" });
  });

  it("concludes with a verdict and refuses later edits", () => {
    const experiment = createFixture("Concluded experiment");
    const concluded = store.concludeExperiment(experiment.id, {
      outcome: "win",
      note: "Activation improved without hurting retention.",
    });

    expect(concluded).toMatchObject({
      ok: true,
      value: {
        status: "concluded",
        verdict: {
          outcome: "win",
          note: "Activation improved without hurting retention.",
          concludedAt: expect.any(String),
        },
      },
    });
    expect(store.updateExperiment(experiment.id, { horizonDays: 60 })).toMatchObject({
      ok: false,
      reason: "conflict",
    });
  });
});
