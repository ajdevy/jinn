import { expect } from "vitest";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import type { JinnConfig } from "../../shared/types.js";
import { handleApiRequest } from "../api.js";
import type { ApiContext } from "../api.js";

/**
 * The request rig the domain-router contract files share. It is a module rather
 * than a block each of them repeats because `vi.mock` is per-file — the mocks have
 * to be declared in the test file, but the fake request/response pair and the
 * fixtures the routes are pinned against do not. The temp home those mocks point at
 * lives in domain-router-home.ts, which this file must not be merged into.
 */

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
export async function call(method: string, url: string, body?: unknown, headers?: Record<string, string>) {
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

// The create body every experiment test starts from, and the wire shape it comes
// back as. `id` and `startedAt` are generated per run, so they are read off the
// response and everything derived from them is recomputed here rather than pinned
// to a literal.
export const RUN = {
  name: "Shorter onboarding",
  hypothesis: "Cutting the product tour raises activation.",
  baseline: { activation: 40 },
  metrics: [{ name: "activation", unit: "%", howToMeasure: "Read the activation dashboard." }],
  horizonDays: 14,
};

export function runningExperiment(id: string, startedAt: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: RUN.name,
    hypothesis: RUN.hypothesis,
    status: "running",
    startedAt,
    horizonDays: RUN.horizonDays,
    horizonEndsAt: new Date(Date.parse(startedAt) + RUN.horizonDays * 86_400_000).toISOString(),
    overdue: false,
    baseline: RUN.baseline,
    metrics: RUN.metrics,
    readings: [],
    ...over,
  };
}

/** POST the standard body and hand back the created experiment. */
export async function createExperiment(over: Record<string, unknown> = {}): Promise<any> {
  const created = await call("POST", "/api/experiments", { ...RUN, ...over });
  expect(created.status).toBe(201);
  return created.body.experiment;
}
