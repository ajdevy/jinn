import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-anomaly-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Runs = typeof import("../runs.js");
type Detect = typeof import("../anomaly-detect.js");
type Approvals = typeof import("../approvals.js");

let store: Store;
let runs: Runs;
let detect: Detect;
let approvals: Approvals;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  runs = await import("../runs.js");
  detect = await import("../anomaly-detect.js");
  approvals = await import("../approvals.js");
  db = (await import("../../shared/db.js")).initDb();
});

describe("detectTodoAnomalies", () => {
  it("creates zero Todos and zero sessions on a healthy board", () => {
    const beforeItems = store.listWorkItems({}).length;
    const beforeSessions = db.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number };
    const healthy = store.createWorkItem({ title: "quiet backlog" });
    const found = detect.detectTodoAnomalies({ now: new Date(), persist: false });
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

  it("closes approved-landed leftovers through the complete() port", () => {
    const item = store.createWorkItem({
      title: "approved landing still open", status: "in_review", assignee: "platform-worker",
    });
    const sessionId = `s-${item.id}`;
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, created_at, last_activity)
       VALUES (?, 'claude', 'cron', ?, 'idle', ?, ?, ?)`,
    ).run(sessionId, `cron:${sessionId}`, item.id, new Date().toISOString(), new Date().toISOString());
    const run = runs.openWorkItemRun({ workItemId: item.id, sessionId });
    runs.closeWorkItemRun(run.id, { outcome: "completed", endedAt: new Date().toISOString() });
    approvals.requestApproval(item.id, {
      request: "Land?", ref: `workflow:pipeline:${run.id}:gate`, target: "operator",
    });
    approvals.decideWorkItemApprovalSync({ id: item.id, decision: "approve", decidedBy: "operator" });
    expect(store.getWorkItem(item.id)!.status).toBe("in_review");
    const closed: string[] = [];
    const found = detect.detectTodoAnomalies({
      persist: true,
      approvedLandingComplete: (todoId) => todoId === item.id,
      closeApprovedLanded: (todoId) => {
        closed.push(todoId);
        return todoId === item.id;
      },
    });
    expect(found.some((row) => row.workItemId === item.id && row.kind === "approved-landed-open")).toBe(true);
    expect(closed).toContain(item.id);
    expect(store.listWorkItemEvents(item.id).some((event) => event.kind === "anomaly_observed")).toBe(false);
  });

  it("puts an unclosed approved-landed leftover on Manager attention", () => {
    const item = store.createWorkItem({
      title: "approved landing still open for the board", status: "in_review", assignee: "platform-worker",
    });
    const sessionId = `s-${item.id}`;
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, created_at, last_activity)
       VALUES (?, 'claude', 'cron', ?, 'idle', ?, ?, ?)`,
    ).run(sessionId, `cron:${sessionId}`, item.id, new Date().toISOString(), new Date().toISOString());
    const run = runs.openWorkItemRun({ workItemId: item.id, sessionId });
    runs.closeWorkItemRun(run.id, { outcome: "completed", endedAt: new Date().toISOString() });
    approvals.requestApproval(item.id, {
      request: "Land?", ref: `workflow:pipeline:${run.id}:gate`, target: "operator",
    });
    approvals.decideWorkItemApprovalSync({ id: item.id, decision: "approve", decidedBy: "operator" });
    detect.detectTodoAnomalies({ persist: true,
      approvedLandingComplete: (todoId) => todoId === item.id,
      closeApprovedLanded: () => false });
    const hits = store.listWorkItems({ needsAttentionFor: "operator" }).map((row) => row.id);
    expect(hits).toContain(item.id);
  });

  it("does not flag an execution-timeout while the session is still in flight", () => {
    const startedAt = new Date(Date.now() - 5 * 60 * 60_000).toISOString();
    const item = store.createWorkItem({ title: "long running", status: "executing" });
    const sessionId = `s-live-${item.id}`;
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, created_at, last_activity)
       VALUES (?, 'claude', 'cron', ?, 'running', ?, ?, ?)`,
    ).run(sessionId, `cron:${sessionId}`, item.id, startedAt, startedAt);
    runs.openWorkItemRun({ workItemId: item.id, sessionId, startedAt });
    expect(detect.detectAnomalyFor(item.id)).toBeUndefined();
  });

  it("writes no anomaly rows when persist is off", () => {
    const item = store.createWorkItem({ title: "stuck assigned off", status: "assigned" });
    store.appendWorkItemEvent({
      workItemId: item.id, kind: "status_change", fromStatus: "backlog", toStatus: "assigned",
      actor: "workflow:run", detail: { workflowId: "pipeline", runId: "run_old" }, versionEffect: "audit",
    });
    detect.detectTodoAnomalies({ persist: false });
    expect(store.listWorkItemEvents(item.id).some((event) => event.kind === "anomaly_observed")).toBe(false);
  });
});
