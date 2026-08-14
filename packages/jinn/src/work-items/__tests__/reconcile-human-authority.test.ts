import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from JINN_HOME at module load). Keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-human-authority-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Reconcile = typeof import("../reconcile.js");
type Transitions = typeof import("../transitions.js");

let store: Store;
let reconcile: Reconcile;
let transitions: Transitions;
let db: import("better-sqlite3").Database;

/** The operator's moves land at wall-clock now, so an attempt's age is only
 *  meaningful relative to that clock. */
const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();
const afterTheMove = (): string => new Date(Date.now() + 60_000).toISOString();

type SessionStatus = "idle" | "running" | "error" | "waiting" | "interrupted";
type AttemptOutcome = "succeeded" | "failed" | "interrupted" | null;

function linkedSession(id: string, workItemId: string, status: SessionStatus, at: string, outcome: AttemptOutcome): void {
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, status, attempt_outcome, work_item_id, created_at, last_activity)
     VALUES (?, 'claude', 'cron', ?, ?, ?, ?, ?, ?)`,
  ).run(id, `cron:${id}`, status, outcome, workItemId, at, at);
}

/**
 * PLA-61's sequence: an attempt that settled ten days ago, then somebody walking
 * the Todo executing → blocked → backlog today. `actor` is what the test varies —
 * only `operator` carries human authority.
 */
function parkedAfterStaleAttempt(title: string, sessionId: string, actor = "operator"): string {
  const item = store.createWorkItem({ title, status: "executing", source: "delegation", sourceRef: `delegate:${sessionId}` });
  linkedSession(sessionId, item.id, "idle", daysAgo(10), "succeeded");
  transitions.transition(item.id, "blocked", actor);
  transitions.transition(item.id, "backlog", actor, { detail: { note: "Parked in backlog: never started, no branch, no run." } });
  return item.id;
}

const statusMoves = (id: string) =>
  store.listWorkItemEvents(id)
    .filter((event) => event.kind === "status_change")
    .map((event) => `${event.fromStatus}→${event.toStatus}:${event.actor}`);

beforeAll(async () => {
  store = await import("../store.js");
  reconcile = await import("../reconcile.js");
  transitions = await import("../transitions.js");
  db = (await import("../../shared/db.js")).initDb();
});

describe("reconcileWorkItem — attempts that predate the operator's own move are not evidence (PLA-98)", () => {
  it("leaves a Todo the operator parked in backlog exactly where he put it (PLA-61, replayed)", () => {
    const id = parkedAfterStaleAttempt("never started", "s-pla61");

    expect(reconcile.reconcileWorkItem(id)).toMatchObject({ changed: false, item: { status: "backlog" } });
    expect(store.getWorkItem(id)?.status).toBe("backlog");
    // The whole complaint: a derived move appearing seconds after a human one.
    expect(statusMoves(id)).toEqual(["executing→blocked:operator", "blocked→backlog:operator"]);
  });

  it("stays put across repeated sweeps (the reconciler runs every 20s, not once)", () => {
    const id = parkedAfterStaleAttempt("still never started", "s-repeat");

    expect(reconcile.reconcileWorkItem(id)).toMatchObject({ changed: false, item: { status: "backlog" } });
    expect(reconcile.reconcileWorkItem(id)).toMatchObject({ changed: false, item: { status: "backlog" } });
    expect(store.getWorkItem(id)?.status).toBe("backlog");
    expect(statusMoves(id)).toEqual(["executing→blocked:operator", "blocked→backlog:operator"]);
  });

  it("derives EXECUTING again once an attempt is running after the move (the floor self-clears)", () => {
    const id = parkedAfterStaleAttempt("restarted by hand", "s-stale-restart");
    linkedSession("s-live-restart", id, "running", afterTheMove(), null);

    expect(reconcile.reconcileWorkItem(id)).toMatchObject({ changed: true, item: { status: "executing" } });
    expect(store.getWorkItem(id)?.status).toBe("executing");
  });

  it("derives IN_REVIEW again once an attempt has SETTLED after the move (new receipt, new evidence)", () => {
    const id = parkedAfterStaleAttempt("retried and finished", "s-stale-retry");
    linkedSession("s-settled-retry", id, "idle", afterTheMove(), "succeeded");

    expect(reconcile.reconcileWorkItem(id)).toMatchObject({ changed: true, item: { status: "in_review" } });
    expect(store.getWorkItem(id)?.status).toBe("in_review");
  });

  it("does not TRUST-close a review the operator opened himself with nothing settled since", () => {
    const item = store.createWorkItem({ title: "cron review", status: "executing", source: "cron", sourceRef: "cron:trust-hold" });
    linkedSession("s-trust-stale", item.id, "idle", daysAgo(10), "succeeded");
    transitions.transition(item.id, "in_review", "operator");

    expect(reconcile.reconcileWorkItem(item.id)).toMatchObject({ changed: false, item: { status: "in_review" } });
    expect(store.getWorkItem(item.id)?.status).toBe("in_review");
    expect(statusMoves(item.id)).toEqual(["executing→in_review:operator"]);
  });

  it("TRUST-closes again once an attempt has settled after the move (the floor self-clears here too)", () => {
    const item = store.createWorkItem({ title: "cron retried", status: "executing", source: "cron", sourceRef: "cron:trust-clear" });
    linkedSession("s-trust-stale-2", item.id, "idle", daysAgo(10), "succeeded");
    transitions.transition(item.id, "in_review", "operator");
    linkedSession("s-trust-fresh", item.id, "idle", afterTheMove(), "succeeded");

    expect(reconcile.reconcileWorkItem(item.id)).toMatchObject({ changed: true, item: { status: "done" } });
    expect(store.getWorkItem(item.id)?.status).toBe("done");
  });

  it("applies no floor to an agent-declared move — a session actor derives exactly as before", () => {
    const id = parkedAfterStaleAttempt("agent parked", "s-agent-move", "session:8f2c1d64-0a15-4c7e-9f3b-2d6e5a0b1c74");

    expect(reconcile.reconcileWorkItem(id)).toMatchObject({ changed: true, item: { status: "in_review" } });
  });

  it("applies no floor to the reconciler's own move — derivation is not authority over itself", () => {
    const id = parkedAfterStaleAttempt("reconciler parked", "s-reconciler-move", store.RECONCILER_ACTOR);

    expect(reconcile.reconcileWorkItem(id)).toMatchObject({ changed: true, item: { status: "in_review" } });
  });
});
