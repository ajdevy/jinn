import type { ExperimentMetric, ExperimentStoreResult } from "../shared/types.js";

type Failure = Extract<ExperimentStoreResult<never>, { ok: false }>;

export const NAME_MAX = 240;
export const HYPOTHESIS_MAX = 8_000;
export const METRIC_NAME_MAX = 120;
export const UNIT_MAX = 64;
export const MEASUREMENT_MAX = 4_000;
export const NOTE_MAX = 8_000;

export function failure(reason: Failure["reason"], detail: string): Failure {
  return { ok: false, reason, detail };
}

export function isFailure<T>(value: T | Failure): value is Failure {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === false;
}

export function requiredText(value: unknown, field: string, max: number): string | Failure {
  if (typeof value !== "string" || !value.trim()) return failure("invalid", `${field} is required and must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > max) return failure("invalid", `${field} is too long (${normalized.length} chars, max ${max})`);
  return normalized;
}

function normalizeMetric(raw: unknown): ExperimentMetric | Failure {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return failure("invalid", "each metric must be an object");
  const record = raw as Record<string, unknown>;
  const name = requiredText(record.name, "metric name", METRIC_NAME_MAX);
  if (typeof name !== "string") return name;
  const howToMeasure = requiredText(record.howToMeasure, `howToMeasure for ${name}`, MEASUREMENT_MAX);
  if (typeof howToMeasure !== "string") return howToMeasure;
  if (record.unit === undefined) return { name, howToMeasure };
  const unit = requiredText(record.unit, `unit for ${name}`, UNIT_MAX);
  if (typeof unit !== "string") return unit;
  return { name, unit, howToMeasure };
}

export function normalizeMetrics(value: unknown): ExperimentMetric[] | Failure {
  if (!Array.isArray(value) || value.length === 0) return failure("invalid", "metrics must contain at least one metric");
  const metrics: ExperimentMetric[] = [];
  const names = new Set<string>();
  for (const raw of value) {
    const metric = normalizeMetric(raw);
    if (isFailure(metric)) return metric;
    if (names.has(metric.name)) return failure("invalid", `metric names must be unique; "${metric.name}" appears more than once`);
    names.add(metric.name);
    metrics.push(metric);
  }
  return metrics;
}

export function normalizeHorizon(value: unknown): number | Failure {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 36_500) {
    return failure("invalid", "horizonDays must be a positive integer no greater than 36500");
  }
  return value;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function normalizeBaseline(value: unknown, metrics: ExperimentMetric[]): Record<string, number> | Failure {
  if (!value || typeof value !== "object" || Array.isArray(value)) return failure("invalid", "baseline must be an object of finite metric values");
  const baseline = value as Record<string, unknown>;
  const names = new Set(metrics.map((metric) => metric.name));
  for (const name of names) {
    if (!isFiniteNumber(baseline[name])) return failure("invalid", `baseline must include a finite number for metric "${name}"`);
  }
  for (const [name, metricValue] of Object.entries(baseline)) {
    if (!names.has(name)) return failure("invalid", `baseline metric "${name}" is not declared in metrics`);
    if (!isFiniteNumber(metricValue)) return failure("invalid", `baseline value for "${name}" must be finite`);
  }
  // Every entry is a finite number by the loops above.
  return { ...baseline } as Record<string, number>;
}
