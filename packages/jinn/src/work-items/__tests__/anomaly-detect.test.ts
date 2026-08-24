import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-anomaly-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Runs = typeof import("../runs.js");
type Detect = typeof import("../anomaly-detect.js");
type Sessions = typeof import("../../sessions/registry.js");

let store: Store;
let runs: Runs;
let detect: Detect;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  runs = await import("../runs.js");
  detect = await import("../anomaly-detect.js");
  db = (await import("../../shared/db.js")).initDb();
  void (0 as unknown as Sessions);
});

describe("detectTodoAnomalies", () => {
  it("creates zero Todos and zero sessions on a healthy board", () => {
    const beforeItems = store.listWorkItems({}).length;
    const beforeSessions = db.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number };
    const healthy = store.createWorkItem({ title: "quiet backlog" });
    const found = detect.detectTodoAnomalies(new Date(), false);
    expect(found.filter((row) => row.workItemId === healthy.id)).toEqual([]);
    expect(store.listWorkItems({}).length).toBe(beforeItems + 1);
    expect((db.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number }).n).toBe(beforeSessions.n);
  });

  it("flags assigned-without-run when a pipeline owns the Todo and nothing is running", () => {
    const item = store.createWorkItem({ title: "stuck assigned", status: "assigned" });
    store.appendWorkItemEvent({
      workItemId: item.id, kind: "status_change", fromStatus: "backlog", toStatus: "assigned",
      actor: "workflow:run", detail: { workflowId: "pipeline", runId: "run_old" }, versionEffect: "audit",
    });
    const found = detect.detectAnomalyFor(item.id);
    expect(found).toMatchObject({ kind: "assigned-without-run", lane: "recovering" });
  });

  it("flags blocked-without-recovery for a code failure", () => {
    const item = store.createWorkItem({ title: "blocked code", status: "blocked", assignee: "platform-worker" });
    const sessionId = `s-${item.id}`;
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, created_at, last_activity)
       VALUES (?, 'claude', 'cron', ?, 'idle', ?, ?, ?)`,
    ).run(sessionId, `cron:${sessionId}`, item.id, new Date().toISOString(), new Date().toISOString());
    const run = runs.openWorkItemRun({ workItemId: item.id, sessionId });
    runs.closeWorkItemRun(run.id, {
      outcome: "crashed", endedAt: new Date().toISOString(), error: "the build step exited with code 1",
    });
    const found = detect.detectAnomalyFor(item.id);
    expect(found).toMatchObject({ kind: "blocked-without-recovery", lane: "manager" });
  });
});
