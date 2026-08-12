import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from JINN_HOME at module load). Keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-runs-delegation-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Runs = typeof import("../runs.js");
type Reconcile = typeof import("../reconcile.js");

let store: Store;
let runs: Runs;
let reconcile: Reconcile;
let db: import("better-sqlite3").Database;

type AttemptOutcome = "succeeded" | "failed" | "interrupted";

/** A delegated session carrying its terminal receipt, linked to the Todo. */
function settledSession(id: string, workItemId: string, outcome: AttemptOutcome): void {
  const status = outcome === "succeeded" ? "idle" : outcome === "failed" ? "error" : "interrupted";
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, status, attempt_outcome, work_item_id, created_at, last_activity)
     VALUES (?, 'claude', 'web', ?, ?, ?, ?, '2026-08-13T09:00:00.000Z', '2026-08-13T09:00:00.000Z')`,
  ).run(id, `delegation:${id}`, status, outcome, workItemId);
}

/** A Workflow phase session: linked to the run's bound Todo, but the run owns it. */
function settledPhaseSession(id: string, workItemId: string): void {
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, status, attempt_outcome, work_item_id,
       workflow_kind, workflow_id, workflow_name, workflow_run_id, workflow_trigger_source,
       workflow_phase_node_id, workflow_phase_name, workflow_phase_index, workflow_phase_round, workflow_phase_attempt,
       created_at, last_activity)
     VALUES (?, 'claude', 'workflow', ?, 'idle', 'succeeded', ?, 'phase', 'pipeline', 'Pipeline', 'run-1', 'workflow',
       'plan', 'Plan', 1, 1, 1, '2026-08-13T09:00:00.000Z', '2026-08-13T09:00:00.000Z')`,
  ).run(id, `workflow:pipeline:run-1:plan:1`, workItemId);
}

beforeAll(async () => {
  store = await import("../store.js");
  runs = await import("../runs.js");
  reconcile = await import("../reconcile.js");
  db = (await import("../../shared/db.js")).initDb();
});

describe("the reconciler settles the run ledger from attempt receipts (ICI-728)", () => {
  it.each([
    ["succeeded", "completed"],
    ["failed", "blocked"],
    ["interrupted", "abandoned"],
  ] as const)("closes the open run as %s → %s", (receipt, outcome) => {
    const item = store.createWorkItem({ title: `settled ${receipt}`, status: "executing", source: "delegation" });
    const sessionId = `s-settle-${receipt}`;
    settledSession(sessionId, item.id, receipt);
    const open = runs.openWorkItemRun({ workItemId: item.id, sessionId });

    reconcile.reconcileWorkItem(item.id);

    const settled = runs.listWorkItemRuns(item.id);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ id: open.id, outcome });
    expect(settled[0].endedAt).not.toBeNull();
  });

  it("does not reopen or re-close a run on a second pass", () => {
    const item = store.createWorkItem({ title: "idempotent settle", status: "executing", source: "delegation" });
    settledSession("s-settle-twice", item.id, "succeeded");
    runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-settle-twice" });

    reconcile.reconcileWorkItem(item.id);
    const first = runs.listWorkItemRuns(item.id);
    reconcile.reconcileWorkItem(item.id);

    expect(runs.listWorkItemRuns(item.id)).toEqual(first);
  });

  it("leaves a Workflow phase session's run open — the run settles its own attempts", () => {
    const item = store.createWorkItem({ title: "phase-bound", status: "executing", source: "human" });
    settledPhaseSession("s-phase-run", item.id);
    runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-phase-run" });

    reconcile.reconcileWorkItem(item.id);

    expect(runs.listWorkItemRuns(item.id)[0]).toMatchObject({ endedAt: null, outcome: null });
  });

  it("is unbothered by a settled session that never opened a run", () => {
    const item = store.createWorkItem({ title: "no ledger row", status: "executing", source: "delegation" });
    settledSession("s-no-run", item.id, "succeeded");

    expect(reconcile.reconcileWorkItem(item.id)?.item.status).toBe("in_review");
    expect(runs.listWorkItemRuns(item.id)).toEqual([]);
  });
});

describe("the startup sweep settles orphaned runs (ICI-728)", () => {
  it("closes a run whose session no longer exists as crashed", () => {
    const item = store.createWorkItem({ title: "vanished session", status: "executing", source: "delegation" });
    const open = runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-vanished" });

    reconcile.reconcileWorkItemsOnStartup();

    const settled = runs.listWorkItemRuns(item.id);
    expect(settled[0]).toMatchObject({ id: open.id, outcome: "crashed" });
    expect(settled[0].endedAt).not.toBeNull();
    expect(settled[0].error).toMatch(/session/i);
  });

  it("returns the status-change count, which an orphan repair does not inflate", () => {
    const item = store.createWorkItem({ title: "orphan only", status: "backlog", source: "delegation" });
    runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-orphan-only" });

    expect(reconcile.reconcileWorkItemsOnStartup()).toBe(0);
    expect(runs.listWorkItemRuns(item.id)[0].outcome).toBe("crashed");
  });
});
