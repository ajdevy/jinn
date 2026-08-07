import { initDb } from "../shared/db.js";
import type { Experiment, ExperimentMetric, ExperimentReading, ExperimentVerdict } from "../shared/types.js";

const DAY_MS = 86_400_000;

interface MetricRow {
  experiment_id: string;
  name: string;
  unit: string | null;
  how_to_measure: string;
}

interface ReadingRow {
  id: string;
  experiment_id: string;
  at: string;
  metric: string;
  value: number;
  note: string | null;
}

export function experimentHorizonEndsAt(startedAt: string, horizonDays: number): string {
  return new Date(Date.parse(startedAt) + horizonDays * DAY_MS).toISOString();
}

function toMetric(row: MetricRow): ExperimentMetric {
  return { name: row.name, ...(row.unit ? { unit: row.unit } : {}), howToMeasure: row.how_to_measure };
}

function toReading(row: ReadingRow): ExperimentReading {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    at: row.at,
    metric: row.metric,
    value: row.value,
    ...(row.note ? { note: row.note } : {}),
  };
}

export function readMetrics(id: string): ExperimentMetric[] {
  const rows = initDb().prepare(
    `SELECT experiment_id, name, unit, how_to_measure
       FROM experiment_metrics
      WHERE experiment_id = ?
      ORDER BY ordinal, name`,
  ).all(id) as MetricRow[];
  return rows.map(toMetric);
}

export function readReadings(id: string): ExperimentReading[] {
  const rows = initDb().prepare(
    `SELECT id, experiment_id, at, metric, value, note
       FROM experiment_readings
      WHERE experiment_id = ?
      ORDER BY at, id`,
  ).all(id) as ReadingRow[];
  return rows.map(toReading);
}

export function rowToExperiment(
  row: Record<string, unknown>,
  metrics: ExperimentMetric[],
  readings: ExperimentReading[],
): Experiment {
  const outcome = row.verdict_outcome as ExperimentVerdict["outcome"] | null;
  const concludedAt = row.concluded_at as string | null;
  const verdictNote = row.verdict_note as string | null;
  const status = row.status as Experiment["status"];
  const startedAt = row.started_at as string;
  const horizonDays = row.horizon_days as number;
  const horizonEndsAt = experimentHorizonEndsAt(startedAt, horizonDays);
  return {
    id: row.id as string,
    name: row.name as string,
    hypothesis: row.hypothesis as string,
    status,
    startedAt,
    horizonDays,
    horizonEndsAt,
    overdue: status === "running" && Date.now() > Date.parse(horizonEndsAt),
    baseline: JSON.parse(row.baseline_json as string) as Record<string, number>,
    metrics,
    readings,
    ...(outcome && concludedAt && verdictNote !== null
      ? { verdict: { outcome, note: verdictNote, concludedAt } }
      : {}),
    ...(typeof row.check_in_cron_job_id === "string" && row.check_in_cron_job_id
      ? { checkInCronJobId: row.check_in_cron_job_id }
      : {}),
  };
}

function groupByExperiment<Row extends { experiment_id: string }, Value>(
  rows: Row[],
  map: (row: Row) => Value,
): Map<string, Value[]> {
  const grouped = new Map<string, Value[]>();
  for (const row of rows) {
    const existing = grouped.get(row.experiment_id);
    if (existing) existing.push(map(row));
    else grouped.set(row.experiment_id, [map(row)]);
  }
  return grouped;
}

// Two queries for the whole page rather than two per row. The per-experiment
// ordering matches readMetrics/readReadings exactly — the detail chart reads
// readings in insertion order and would draw a different line otherwise.
export function hydrateExperiments(rows: Record<string, unknown>[]): Experiment[] {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id as string);
  const placeholders = ids.map(() => "?").join(", ");
  const db = initDb();
  const metricRows = db.prepare(
    `SELECT experiment_id, name, unit, how_to_measure
       FROM experiment_metrics
      WHERE experiment_id IN (${placeholders})
      ORDER BY experiment_id, ordinal, name`,
  ).all(...ids) as MetricRow[];
  const readingRows = db.prepare(
    `SELECT id, experiment_id, at, metric, value, note
       FROM experiment_readings
      WHERE experiment_id IN (${placeholders})
      ORDER BY experiment_id, at, id`,
  ).all(...ids) as ReadingRow[];
  const metricsById = groupByExperiment(metricRows, toMetric);
  const readingsById = groupByExperiment(readingRows, toReading);
  return rows.map((row) => rowToExperiment(
    row,
    metricsById.get(row.id as string) ?? [],
    readingsById.get(row.id as string) ?? [],
  ));
}
