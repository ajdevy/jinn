import crypto from "node:crypto";
import { canonicalCronJobId, loadJobs, saveJobs } from "../cron/jobs.js";
import { validateCronSchedule } from "../cron/validation.js";
import type { CronJob, ExperimentStoreResult } from "../shared/types.js";
import { experimentHorizonEndsAt, type HydratedExperiment } from "./hydrate.js";
import {
  concludeExperiment,
  createExperiment,
  getExperiment,
  updateExperiment,
  type ConcludeExperimentInput,
  type CreateExperimentInput,
  type UpdateExperimentInput,
} from "./store.js";
import { normalizeHorizon } from "./validation.js";

export interface ExperimentCheckInInput {
  schedule: string;
  employee?: string;
  timezone?: string;
}

type Failure = Extract<ExperimentStoreResult<never>, { ok: false }>;

function failure(reason: Failure["reason"], detail: string): Failure {
  return { ok: false, reason, detail };
}

function generatedExperimentId(): string {
  return `exp_${crypto.randomBytes(6).toString("hex")}`;
}

type CheckInSubject = Pick<HydratedExperiment, "id" | "name" | "metrics" | "horizonEndsAt">;

function checkInPrompt(experiment: CheckInSubject): string {
  const instructions = experiment.metrics
    .map((metric) => `- ${metric.name}${metric.unit ? ` (${metric.unit})` : ""}: ${metric.howToMeasure}`)
    .join("\n");
  return [
    `Check in on experiment "${experiment.name}" (${experiment.id}).`,
    "Measure every declared metric using these instructions:",
    instructions,
    `Append each result with record_reading using id "${experiment.id}".`,
    // Static text rather than a computed "overdue" flag: the prompt is written
    // once per edit and read on every fire, so the deadline has to be a date the
    // reader can compare against, not a snapshot of how things stood.
    `This experiment's horizon ends ${experiment.horizonEndsAt.slice(0, 10)}. Once that date has passed, call conclude_experiment with a verdict instead of only recording another reading.`,
  ].join("\n\n");
}

function checkInJobName(experimentName: string): string {
  return `Experiment check-in: ${experimentName}`;
}

function validateCheckIn(input: ExperimentCheckInInput): Failure | null {
  const errors = validateCronSchedule({ schedule: input.schedule, timezone: input.timezone });
  if (errors.length > 0) return failure("invalid", errors.map((error) => `${error.field}: ${error.message}`).join("; "));
  if (input.employee !== undefined && (typeof input.employee !== "string" || !input.employee.trim())) {
    return failure("invalid", "employee must be a non-empty string");
  }
  return null;
}

function registerExperimentCheckIn(
  experiment: CheckInSubject,
  input: ExperimentCheckInInput,
  jobId = `experiment-check-in-${experiment.id}`,
): ExperimentStoreResult<CronJob> {
  const invalid = validateCheckIn(input);
  if (invalid) return invalid;
  const jobs = loadJobs();
  const canonicalId = canonicalCronJobId(jobId);
  if (jobs.some((job) => canonicalCronJobId(job.id) === canonicalId)) {
    return failure("conflict", `cron job "${jobId}" already exists`);
  }
  const job: CronJob = {
    id: jobId,
    name: checkInJobName(experiment.name),
    enabled: true,
    schedule: input.schedule.trim(),
    ...(input.timezone ? { timezone: input.timezone.trim() } : {}),
    ...(input.employee ? { employee: input.employee.trim() } : {}),
    prompt: checkInPrompt(experiment),
  };
  saveJobs([...jobs, job]);
  return { ok: true, value: job };
}

function disableExperimentCheckIn(jobId: string): void {
  const jobs = loadJobs();
  const index = jobs.findIndex((job) => canonicalCronJobId(job.id) === canonicalCronJobId(jobId));
  if (index < 0 || !jobs[index].enabled) return;
  const next = [...jobs];
  next[index] = { ...next[index], enabled: false };
  saveJobs(next);
}

function removeExperimentCheckIn(jobId: string): void {
  const jobs = loadJobs();
  const next = jobs.filter((job) => canonicalCronJobId(job.id) !== canonicalCronJobId(jobId));
  if (next.length !== jobs.length) saveJobs(next);
}

export function createExperimentWithCheckIn(
  input: CreateExperimentInput,
  checkIn?: ExperimentCheckInInput,
): ExperimentStoreResult<HydratedExperiment> {
  if (!checkIn) return createExperiment(input);
  const invalid = validateCheckIn(checkIn);
  if (invalid) return invalid;

  // The job is written before the experiment so a rejected schedule cannot leave
  // an orphan row behind, which means the prompt's horizon has to be derived
  // here. startedAt is threaded into the insert so both agree to the millisecond.
  const horizonDays = normalizeHorizon(input.horizonDays);
  if (typeof horizonDays !== "number") return horizonDays;
  const id = generatedExperimentId();
  const jobId = `experiment-check-in-${id}`;
  const startedAt = new Date().toISOString();
  const registered = registerExperimentCheckIn(
    { id, name: input.name, metrics: input.metrics, horizonEndsAt: experimentHorizonEndsAt(startedAt, horizonDays) },
    checkIn,
    jobId,
  );
  if (!registered.ok) return registered;
  try {
    const created = createExperiment(input, { id, checkInCronJobId: jobId, startedAt });
    if (!created.ok) removeExperimentCheckIn(jobId);
    return created;
  } catch (error) {
    removeExperimentCheckIn(jobId);
    throw error;
  }
}

/** Rewrites the registered job from the experiment as it now stands. No-op when
 * the experiment has no check-in, or when its job has since been removed. */
function updateExperimentCheckIn(experiment: HydratedExperiment): void {
  if (!experiment.checkInCronJobId) return;
  const jobs = loadJobs();
  const canonicalId = canonicalCronJobId(experiment.checkInCronJobId);
  const index = jobs.findIndex((job) => canonicalCronJobId(job.id) === canonicalId);
  if (index < 0) return;
  const next = [...jobs];
  next[index] = { ...next[index], name: checkInJobName(experiment.name), prompt: checkInPrompt(experiment) };
  saveJobs(next);
}

export function updateExperimentAndRefreshCheckIn(
  id: string,
  input: UpdateExperimentInput,
): ExperimentStoreResult<HydratedExperiment> {
  const updated = updateExperiment(id, input);
  if (updated.ok) updateExperimentCheckIn(updated.value);
  return updated;
}

export function concludeExperimentAndDisableCheckIn(
  id: string,
  input: ConcludeExperimentInput,
): ExperimentStoreResult<HydratedExperiment> {
  const existing = getExperiment(id);
  if (!existing.ok) return existing;
  if (existing.value.status !== "running") return failure("conflict", "experiment is already concluded");
  const concluded = concludeExperiment(id, input);
  if (!concluded.ok) return concluded;
  if (existing.value.checkInCronJobId) disableExperimentCheckIn(existing.value.checkInCronJobId);
  return concluded;
}
