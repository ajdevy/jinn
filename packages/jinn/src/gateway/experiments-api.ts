import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import {
  getExperiment,
  listExperiments,
  recordReading,
  type CreateExperimentInput,
  type ExperimentStoreResult,
} from "../experiments/store.js";
import {
  concludeExperimentAndDisableCheckIn,
  createExperimentWithCheckIn,
  updateExperimentAndRefreshCheckIn,
  type ExperimentCheckInInput,
} from "../experiments/check-in.js";
import { readJsonBody } from "./http-helpers.js";
import { badRequest, json, matchRoute, type ParsedRoute } from "./route-helpers.js";
import type { ApiContext } from "./api.js";

const EXPERIMENTS_BODY_ROUTE_MAX_BYTES = 128_000;

function experimentStoreFailureResponse(
  res: ServerResponse,
  result: Extract<ExperimentStoreResult<unknown>, { ok: false }>,
): void {
  const status = { invalid: 400, "not-found": 404, conflict: 409 }[result.reason];
  json(res, { error: result.detail }, status);
}

function isPlainObject(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The body as an object, or null when readJsonBody has already answered. */
async function readBody(req: HttpRequest, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const parsed = await readJsonBody(req, res, { maxBytes: EXPERIMENTS_BODY_ROUTE_MAX_BYTES });
  if (!parsed.ok) return null;
  return isPlainObject(parsed.body) ? parsed.body as Record<string, unknown> : {};
}

/** `null` when the optional field is absent or a string. */
function stringFieldError(body: Record<string, unknown>, field: string): string | null {
  return body[field] === undefined || typeof body[field] === "string" ? null : `${field} must be a string`;
}

/** The first thing wrong with the body, or null when it is well formed. */
function createBodyError(body: Record<string, unknown>): string | null {
  if (typeof body.name !== "string") return "name is required and must be a string";
  if (typeof body.hypothesis !== "string") return "hypothesis is required and must be a string";
  if (!isPlainObject(body.baseline)) return "baseline is required and must be an object";
  if (!Array.isArray(body.metrics)) return "metrics is required and must be an array";
  if (typeof body.horizonDays !== "number") return "horizonDays is required and must be a number";
  if (body.checkIn !== undefined && !isPlainObject(body.checkIn)) return "checkIn must be an object";
  return null;
}

function updateBodyError(body: Record<string, unknown>): string | null {
  const wrongType = stringFieldError(body, "name") ?? stringFieldError(body, "hypothesis");
  if (wrongType) return wrongType;
  if (body.horizonDays !== undefined && typeof body.horizonDays !== "number") return "horizonDays must be a number";
  if (body.metrics !== undefined && !Array.isArray(body.metrics)) return "metrics must be an array";
  if (body.baseline !== undefined && !isPlainObject(body.baseline)) return "baseline must be an object";
  return null;
}

function readingBodyError(body: Record<string, unknown>): string | null {
  if (typeof body.at !== "string") return "at is required and must be a string";
  if (typeof body.metric !== "string") return "metric is required and must be a string";
  if (typeof body.value !== "number") return "value is required and must be a number";
  return stringFieldError(body, "note");
}

function concludeBodyError(body: Record<string, unknown>): string | null {
  if (body.outcome !== "win" && body.outcome !== "loss" && body.outcome !== "inconclusive") {
    return "outcome must be win, loss, or inconclusive";
  }
  if (typeof body.note !== "string") return "note is required and must be a string";
  return null;
}

function sendExperimentList(res: ServerResponse, url: URL): void {
  const status = url.searchParams.get("status");
  if (status !== null && status !== "running" && status !== "concluded") {
    return badRequest(res, "status must be running or concluded");
  }
  const limit = url.searchParams.get("limit");
  // A malformed limit becomes NaN and the store clamps it to the default;
  // nothing but a bounded integer reaches SQL.
  return json(res, { experiments: listExperiments(status ?? undefined, limit === null ? undefined : Number(limit)) });
}

function sendExperiment(res: ServerResponse, id: string): void {
  const result = getExperiment(id);
  if (!result.ok) return experimentStoreFailureResponse(res, result);
  return json(res, { experiment: result.value });
}

async function createFromBody(req: HttpRequest, res: ServerResponse, context: ApiContext): Promise<void> {
  const body = await readBody(req, res);
  if (!body) return;
  const invalid = createBodyError(body);
  if (invalid) return badRequest(res, invalid);
  const input: CreateExperimentInput = {
    name: body.name as string,
    hypothesis: body.hypothesis as string,
    baseline: body.baseline as Record<string, number>,
    metrics: body.metrics as CreateExperimentInput["metrics"],
    horizonDays: body.horizonDays as number,
  };
  const result = createExperimentWithCheckIn(input, body.checkIn as ExperimentCheckInInput | undefined);
  if (!result.ok) return experimentStoreFailureResponse(res, result);
  context.emit("experiments:changed", { id: result.value.id, action: "created" });
  return json(res, { experiment: result.value }, 201);
}

async function updateFromBody(req: HttpRequest, res: ServerResponse, id: string, context: ApiContext): Promise<void> {
  const body = await readBody(req, res);
  if (!body) return;
  const invalid = updateBodyError(body);
  if (invalid) return badRequest(res, invalid);
  const result = updateExperimentAndRefreshCheckIn(id, {
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...(typeof body.hypothesis === "string" ? { hypothesis: body.hypothesis } : {}),
    ...(typeof body.horizonDays === "number" ? { horizonDays: body.horizonDays } : {}),
    ...(Array.isArray(body.metrics) ? { metrics: body.metrics as CreateExperimentInput["metrics"] } : {}),
    ...(body.baseline !== undefined ? { baseline: body.baseline as Record<string, number> } : {}),
  });
  if (!result.ok) return experimentStoreFailureResponse(res, result);
  context.emit("experiments:changed", { id: result.value.id, action: "updated" });
  return json(res, { experiment: result.value });
}

async function recordReadingFromBody(req: HttpRequest, res: ServerResponse, id: string, context: ApiContext): Promise<void> {
  const body = await readBody(req, res);
  if (!body) return;
  const invalid = readingBodyError(body);
  if (invalid) return badRequest(res, invalid);
  const result = recordReading(id, {
    at: body.at as string,
    metric: body.metric as string,
    value: body.value as number,
    ...(typeof body.note === "string" ? { note: body.note } : {}),
  });
  if (!result.ok) return experimentStoreFailureResponse(res, result);
  context.emit("experiments:changed", { id, action: "reading-recorded" });
  return json(res, { reading: result.value }, 201);
}

async function concludeFromBody(req: HttpRequest, res: ServerResponse, id: string, context: ApiContext): Promise<void> {
  const body = await readBody(req, res);
  if (!body) return;
  const invalid = concludeBodyError(body);
  if (invalid) return badRequest(res, invalid);
  const result = concludeExperimentAndDisableCheckIn(id, {
    outcome: body.outcome as "win" | "loss" | "inconclusive",
    note: body.note as string,
  });
  if (!result.ok) return experimentStoreFailureResponse(res, result);
  context.emit("experiments:changed", { id: result.value.id, action: "concluded" });
  return json(res, { experiment: result.value });
}

function handleExperimentReads(res: ServerResponse, route: ParsedRoute): boolean {
  const { method, pathname, url } = route;
  if (method !== "GET") return false;
  if (pathname === "/api/experiments") {
    sendExperimentList(res, url);
    return true;
  }
  const experiment = matchRoute("/api/experiments/:id", pathname);
  if (experiment) {
    sendExperiment(res, experiment.id);
    return true;
  }
  return false;
}

async function handleExperimentWrites(
  req: HttpRequest,
  res: ServerResponse,
  route: ParsedRoute,
  context: ApiContext,
): Promise<boolean> {
  const { method, pathname } = route;
  if (method === "POST" && pathname === "/api/experiments") {
    await createFromBody(req, res, context);
    return true;
  }
  const experiment = matchRoute("/api/experiments/:id", pathname);
  if (method === "PATCH" && experiment) {
    await updateFromBody(req, res, experiment.id, context);
    return true;
  }
  const readings = matchRoute("/api/experiments/:id/readings", pathname);
  if (method === "POST" && readings) {
    await recordReadingFromBody(req, res, readings.id, context);
    return true;
  }
  const conclude = matchRoute("/api/experiments/:id/conclude", pathname);
  if (method === "POST" && conclude) {
    await concludeFromBody(req, res, conclude.id, context);
    return true;
  }
  return false;
}

/** `/api/experiments*` routes. See route-helpers.ts for the domain-module contract. */
export async function handleExperimentsApi(
  req: HttpRequest,
  res: ServerResponse,
  route: ParsedRoute,
  context: ApiContext,
): Promise<boolean> {
  return handleExperimentReads(res, route) || (await handleExperimentWrites(req, res, route, context));
}
