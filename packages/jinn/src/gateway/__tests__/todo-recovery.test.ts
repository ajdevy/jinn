import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-gw-todo-recovery-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../../work-items/store.js");
type Runs = typeof import("../../work-items/runs.js");
type Approvals = typeof import("../../work-items/approvals.js");
type Recovery = typeof import("../todo-recovery.js");
type Transitions = typeof import("../../work-items/transitions.js");

let store: Store;
let runs: Runs;
let approvals: Approvals;
let recovery: Recovery;
let transitions: Transitions;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  runs = await import("../../work-items/runs.js");
  approvals = await import("../../work-items/approvals.js");
  transitions = await import("../../work-items/transitions.js");
  recovery = await import("../todo-recovery.js");
  db = (await import("../../shared/db.js")).initDb();
});

describe("closeApprovedLanded", () => {
  it("closes an approved completed run through complete(), leaving the Todo done", () => {
    const item = store.createWorkItem({
      title: "approved landing leftover", status: "assigned", assignee: "platform-worker",
    });
    transitions.transition(item.id, "in_review", "session:worker", { agent: true });
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

    expect(recovery.closeApprovedLanded(item.id)).toBe(true);
    expect(store.getWorkItem(item.id)!.status).toBe("done");
  });

  it("does not close without a completed run; the leftover stays in_review", () => {
    const item = store.createWorkItem({
      title: "approved but not landed", status: "assigned", assignee: "platform-worker",
    });
    transitions.transition(item.id, "in_review", "session:worker", { agent: true });
    approvals.requestApproval(item.id, {
      request: "Land?", ref: "workflow:pipeline:run_missing:gate", target: "operator",
    });
    approvals.decideWorkItemApprovalSync({ id: item.id, decision: "approve", decidedBy: "operator" });
    expect(recovery.closeApprovedLanded(item.id)).toBe(false);
    expect(store.getWorkItem(item.id)!.status).toBe("in_review");
  });
});
