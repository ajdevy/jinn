import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The `/api/org*` half of the domain-router contract. Every moved route is driven
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

import { DISPATCHER, EDGES, PERSONA, WORKER, home, seedHome } from "./domain-router-home.js";
import { call } from "./domain-router-harness.js";

beforeEach(() => {
  seedHome();
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
    expect(JSON.parse(fs.readFileSync(path.join(home.org, "platform", "board.json"), "utf-8"))).toEqual({
      todo: ["rewritten"],
    });

    expect((await call("PUT", "/api/org/departments/ghost/board", { todo: [] })).status).toBe(404);
  });
});
