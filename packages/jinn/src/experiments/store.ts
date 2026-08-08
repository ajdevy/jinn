import crypto from "node:crypto";
import { initDb } from "../shared/db.js";
import type {
  Experiment,
  ExperimentMetric,
  ExperimentReading,
  ExperimentStoreResult,
  ExperimentVerdict,
} from "../shared/types.js";
import { hydrateExperiments, readMetrics, readReadings, rowToExperiment, type HydratedExperiment } from "./hydrate.js";
import {
  failure,
  isFailure,
  normalizeBaseline,
  normalizeHorizon,
  normalizeMetrics,
  requiredText,
  HYPOTHESIS_MAX,
  METRIC_NAME_MAX,
  NAME_MAX,
  NOTE_MAX,
} from "./validation.js";

export type { Experiment, ExperimentMetric, ExperimentReading, ExperimentStoreResult, ExperimentVerdict } from "../shared/types.js";
export type { HydratedExperiment } from "./hydrate.js";

export interface CreateExperimentInput {
  name: string;
  hypothesis: string;
  baseline: Record<string, number>;
  metrics: ExperimentMetric[];
  horizonDays: number;
}

export interface UpdateExperimentInput {
  name?: string;
  hypothesis?: string;
  metrics?: ExperimentMetric[];
  baseline?: Record<string, number>;
  horizonDays?: number;
}

export interface RecordReadingInput {
  at: string;
  metric: string;
  value: number;
  note?: string;
}

export interface ConcludeExperimentInput {
  outcome: ExperimentVerdict["outcome"];
  note: string;
}

interface CreateExperimentInternal {
  id?: string;
  checkInCronJobId?: string;
  startedAt?: string;
}

export const LIST_LIMIT_DEFAULT = 100;
export const LIST_LIMIT_MAX = 500;

function experimentId(): string {
  return `exp_${crypto.randomBytes(6).toString("hex")}`;
}

function readingId(): string {
  return `rd_${crypto.randomBytes(6).toString("hex")}`;
}

// A caller-supplied limit is clamped rather than rejected: the list is a view,
// and a nonsense value should still return a page instead of an error.
function boundedLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) return LIST_LIMIT_DEFAULT;
  return Math.min(Math.floor(limit), LIST_LIMIT_MAX);
}

export function getExperiment(id: string): ExperimentStoreResult<HydratedExperiment> {
  const row = initDb().prepare("SELECT * FROM experiments WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row
    ? { ok: true, value: rowToExperiment(row, readMetrics(id), readReadings(id)) }
    : failure("not-found", `experiment "${id}" was not found`);
}

export function listExperiments(status?: Experiment["status"], limit?: number): HydratedExperiment[] {
  const bounded = boundedLimit(limit);
  const rows = (status
    ? initDb().prepare("SELECT * FROM experiments WHERE status = ? ORDER BY started_at DESC, id LIMIT ?").all(status, bounded)
    : initDb().prepare("SELECT * FROM experiments ORDER BY started_at DESC, id LIMIT ?").all(bounded)) as Record<string, unknown>[];
  return hydrateExperiments(rows);
}

export function createExperiment(
  input: CreateExperimentInput,
  internal: CreateExperimentInternal = {},
): ExperimentStoreResult<HydratedExperiment> {
  const name = requiredText(input.name, "name", NAME_MAX);
  if (typeof name !== "string") return name;
  const hypothesis = requiredText(input.hypothesis, "hypothesis", HYPOTHESIS_MAX);
  if (typeof hypothesis !== "string") return hypothesis;
  const metrics = normalizeMetrics(input.metrics);
  if (!Array.isArray(metrics)) return metrics;
  const horizonDays = normalizeHorizon(input.horizonDays);
  if (typeof horizonDays !== "number") return horizonDays;
  const baseline = normalizeBaseline(input.baseline, metrics);
  if (isFailure(baseline)) return baseline;

  const id = internal.id ?? experimentId();
  const startedAt = internal.startedAt ?? new Date().toISOString();
  const db = initDb();
  const insert = db.transaction(() => {
    db.prepare(
      `INSERT INTO experiments
        (id, name, hypothesis, status, started_at, horizon_days, baseline_json, check_in_cron_job_id)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
    ).run(id, name, hypothesis, startedAt, horizonDays, JSON.stringify(baseline), internal.checkInCronJobId ?? null);
    const insertMetric = db.prepare(
      `INSERT INTO experiment_metrics (experiment_id, ordinal, name, unit, how_to_measure)
       VALUES (?, ?, ?, ?, ?)`,
    );
    metrics.forEach((metric, ordinal) => insertMetric.run(id, ordinal, metric.name, metric.unit ?? null, metric.howToMeasure));
  });
  insert();
  return getExperiment(id);
}

export function recordReading(id: string, input: RecordReadingInput): ExperimentStoreResult<ExperimentReading> {
  const existing = getExperiment(id);
  if (!existing.ok) return existing;
  if (existing.value.status !== "running") return failure("conflict", "readings cannot be added after an experiment is concluded");
  const metric = requiredText(input.metric, "metric", METRIC_NAME_MAX);
  if (typeof metric !== "string") return metric;
  if (!existing.value.metrics.some((candidate) => candidate.name === metric)) {
    return failure("invalid", `metric "${metric}" is not declared on this experiment`);
  }
  if (typeof input.value !== "number" || !Number.isFinite(input.value)) return failure("invalid", "value must be a finite number");
  if (typeof input.at !== "string" || !input.at.trim() || Number.isNaN(Date.parse(input.at))) {
    return failure("invalid", "at must be an ISO-8601 timestamp");
  }
  let note: string | undefined;
  if (input.note !== undefined) {
    if (typeof input.note !== "string" || input.note.length > NOTE_MAX) return failure("invalid", `note must be a string no longer than ${NOTE_MAX} chars`);
    note = input.note.trim() || undefined;
  }
  const reading: ExperimentReading = {
    id: readingId(),
    experimentId: id,
    at: new Date(input.at).toISOString(),
    metric,
    value: input.value,
    ...(note ? { note } : {}),
  };
  initDb().prepare(
    `INSERT INTO experiment_readings (id, experiment_id, at, metric, value, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(reading.id, id, reading.at, reading.metric, reading.value, reading.note ?? null);
  return { ok: true, value: reading };
}

// The baseline follows the metric set: entries for removed metrics are dropped,
// and a newly declared metric needs its own baseline value, supplied here or
// already stored. normalizeBaseline names the metric when one is missing.
function nextBaseline(
  stored: Record<string, number>,
  supplied: Record<string, number> | undefined,
  metrics: ExperimentMetric[],
): Record<string, number> | ReturnType<typeof failure> {
  const declared = new Set(metrics.map((metric) => metric.name));
  for (const name of Object.keys(supplied ?? {})) {
    if (!declared.has(name)) return failure("invalid", `baseline metric "${name}" is not declared in metrics`);
  }
  const kept = Object.entries(stored).filter(([name]) => declared.has(name));
  return normalizeBaseline({ ...Object.fromEntries(kept), ...(supplied ?? {}) }, metrics);
}

export function updateExperiment(id: string, input: UpdateExperimentInput): ExperimentStoreResult<HydratedExperiment> {
  const existing = getExperiment(id);
  if (!existing.ok) return existing;
  if (existing.value.status !== "running") return failure("conflict", "concluded experiments cannot be edited");
  if (input.name === undefined && input.hypothesis === undefined && input.horizonDays === undefined
    && input.metrics === undefined && input.baseline === undefined) {
    return failure("invalid", "at least one editable field is required");
  }
  const name = input.name === undefined ? existing.value.name : requiredText(input.name, "name", NAME_MAX);
  if (typeof name !== "string") return name;
  const hypothesis = input.hypothesis === undefined
    ? existing.value.hypothesis
    : requiredText(input.hypothesis, "hypothesis", HYPOTHESIS_MAX);
  if (typeof hypothesis !== "string") return hypothesis;
  const horizonDays = input.horizonDays === undefined ? existing.value.horizonDays : normalizeHorizon(input.horizonDays);
  if (typeof horizonDays !== "number") return horizonDays;
  const metrics = input.metrics === undefined ? existing.value.metrics : normalizeMetrics(input.metrics);
  if (!Array.isArray(metrics)) return metrics;
  const baseline = nextBaseline(existing.value.baseline, input.baseline, metrics);
  if (isFailure(baseline)) return baseline;

  if (input.metrics !== undefined) {
    const nextNames = new Set(metrics.map((metric) => metric.name));
    const removed = existing.value.metrics.filter((metric) => !nextNames.has(metric.name)).map((metric) => metric.name);
    if (removed.length > 0) {
      const placeholders = removed.map(() => "?").join(", ");
      const count = initDb().prepare(
        `SELECT COUNT(*) FROM experiment_readings WHERE experiment_id = ? AND metric IN (${placeholders})`,
      ).pluck().get(id, ...removed) as number;
      if (count > 0) return failure("conflict", "metrics with recorded readings cannot be removed");
    }
  }

  const db = initDb();
  db.transaction(() => {
    db.prepare("UPDATE experiments SET name = ?, hypothesis = ?, horizon_days = ?, baseline_json = ? WHERE id = ?")
      .run(name, hypothesis, horizonDays, JSON.stringify(baseline), id);
    if (input.metrics !== undefined) {
      const nextNames = new Set(metrics.map((metric) => metric.name));
      for (const metric of existing.value.metrics) {
        if (!nextNames.has(metric.name)) {
          db.prepare("DELETE FROM experiment_metrics WHERE experiment_id = ? AND name = ?").run(id, metric.name);
        }
      }
      const upsert = db.prepare(
        `INSERT INTO experiment_metrics (experiment_id, ordinal, name, unit, how_to_measure)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(experiment_id, name) DO UPDATE SET
           ordinal = excluded.ordinal,
           unit = excluded.unit,
           how_to_measure = excluded.how_to_measure`,
      );
      metrics.forEach((metric, ordinal) => upsert.run(id, ordinal, metric.name, metric.unit ?? null, metric.howToMeasure));
    }
  })();
  return getExperiment(id);
}

export function concludeExperiment(id: string, input: ConcludeExperimentInput): ExperimentStoreResult<HydratedExperiment> {
  const existing = getExperiment(id);
  if (!existing.ok) return existing;
  if (existing.value.status !== "running") return failure("conflict", "experiment is already concluded");
  if (input.outcome !== "win" && input.outcome !== "loss" && input.outcome !== "inconclusive") {
    return failure("invalid", "outcome must be win, loss, or inconclusive");
  }
  if (typeof input.note !== "string" || input.note.length > NOTE_MAX) {
    return failure("invalid", `note must be a string no longer than ${NOTE_MAX} chars`);
  }
  const concludedAt = new Date().toISOString();
  initDb().prepare(
    `UPDATE experiments
        SET status = 'concluded', verdict_outcome = ?, verdict_note = ?, concluded_at = ?
      WHERE id = ?`,
  ).run(input.outcome, input.note.trim(), concludedAt, id);
  return getExperiment(id);
}
