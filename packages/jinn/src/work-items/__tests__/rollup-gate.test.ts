import { describe, it, expect, beforeAll } from "vitest";
import type { Database } from "better-sqlite3";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-gate-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Transitions = typeof import("../transitions.js");
type Approvals = typeof import("../approvals.js");
let store: Store;
let transitions: Transitions;
let approvals: Approvals;
let db: Database;

beforeAll(async () => {
  store = await import("../store.js");
  transitions = await import("../transitions.js");
  approvals = await import("../approvals.js");
  db = (await import("../../shared/db.js")).initDb();
});

/** Run a transition expected to be refused and hand back its code + message. */
function refusalOf(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (err) {
    if (err instanceof transitions.TransitionError) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error("expected the transition to be refused");
}

/** The `done` events for these ids in commit order — how a cascade is proved to
 *  have run deepest-first rather than merely to have finished. */
function closedInOrder(ids: readonly string[]): string[] {
  const placeholders = ids.map(() => "?").join(", ");
  return (db
    .prepare(`SELECT work_item_id, detail FROM work_item_events
              WHERE to_status = 'done' AND work_item_id IN (${placeholders}) ORDER BY rowid`)
    .all(...ids) as Array<{ work_item_id: string }>)
    .map((row) => row.work_item_id);
}

function cascadeFrom(id: string): unknown {
  const row = db
    .prepare("SELECT detail FROM work_item_events WHERE work_item_id = ? AND to_status = 'done' ORDER BY rowid DESC LIMIT 1")
    .get(id) as { detail: string | null } | undefined;
  return JSON.parse(row?.detail ?? "{}").cascadeFrom;
}

describe("roll-up close gate", () => {
  it("refuses done on a parent with an open child", () => {
    const parent = store.createWorkItem({ title: "gate parent" });
    store.createWorkItem({ title: "open child", parentId: parent.id });
    expect(() => transitions.transition(parent.id, "done", "operator", { human: true }))
      .toThrowError(/children-open|open children/);
  });

  it("allows done once all children are terminal", () => {
    const parent = store.createWorkItem({ title: "gate parent 2" });
    const child = store.createWorkItem({ title: "closing child", parentId: parent.id });
    transitions.transition(child.id, "done", "operator", { human: true });
    const result = transitions.transition(parent.id, "done", "operator", { human: true });
    expect(result.item.status).toBe("done");
  });

  it("cascade-cancels descendants depth-first under human authority", () => {
    const parent = store.createWorkItem({ title: "cascade parent" });
    const mid = store.createWorkItem({ title: "mid", parentId: parent.id });
    const leaf = store.createWorkItem({ title: "leaf", parentId: mid.id });
    const archived = approvals.archiveWorkItem(parent.id, "operator", { human: true, cascade: true });
    expect(archived.status).toBe("cancelled");
    expect(store.getWorkItem(mid.id)!.status).toBe("cancelled");
    expect(store.getWorkItem(leaf.id)!.status).toBe("cancelled");
  });

  it("refuses archive on a parent with open children when cascade is not set", () => {
    const parent = store.createWorkItem({ title: "no-cascade parent" });
    store.createWorkItem({ title: "still open", parentId: parent.id });
    expect(() => approvals.archiveWorkItem(parent.id, "operator", { human: true })).toThrow();
  });
});

describe("cascade close", () => {
  it("leaves the default refusal word-for-word when cascade is not asked for", () => {
    const parent = store.createWorkItem({ title: "default gate parent" });
    const child = store.createWorkItem({ title: "default gate child", parentId: parent.id });
    const refused = refusalOf(() => transitions.transition(parent.id, "done", "operator", { human: true }));
    expect(refused.code).toBe("children-open");
    expect(refused.message).toBe(
      `work item ${parent.id} still has open children (e.g. ${child.id}) — close or cancel them first`,
    );
  });

  it("closes every open descendant deepest-first, stamped with the parent it came from", () => {
    const parent = store.createWorkItem({ title: "cascade parent" });
    const mid = store.createWorkItem({ title: "cascade mid", parentId: parent.id });
    const leaf = store.createWorkItem({ title: "cascade leaf", parentId: mid.id });
    const result = transitions.transition(parent.id, "done", "operator", { human: true, cascade: true });
    expect(result.item.status).toBe("done");
    expect(store.getWorkItem(mid.id)!.status).toBe("done");
    expect(store.getWorkItem(leaf.id)!.status).toBe("done");
    expect(closedInOrder([parent.id, mid.id, leaf.id])).toEqual([leaf.id, mid.id, parent.id]);
    expect(cascadeFrom(leaf.id)).toBe(parent.id);
    expect(cascadeFrom(mid.id)).toBe(parent.id);
    expect(cascadeFrom(parent.id)).toBeUndefined();
  });

  it("leaves the whole tree at its pre-call status when a descendant's write fails", () => {
    const parent = store.createWorkItem({ title: "rollback parent" });
    const mid = store.createWorkItem({ title: "rollback mid", parentId: parent.id });
    const leaf = store.createWorkItem({ title: "rollback leaf", parentId: mid.id });
    // A trigger is the only deterministic mid-cascade failure available: every
    // status in an open tree has a legal `done` edge, so nothing the caller can
    // pass makes the second descendant refuse on its own.
    db.exec(`CREATE TEMP TRIGGER cascade_rollback_probe BEFORE UPDATE ON work_items
             WHEN NEW.id = '${mid.id}' AND NEW.status = 'done'
             BEGIN SELECT RAISE(ABORT, 'forced mid-cascade failure'); END`);
    try {
      expect(() => transitions.transition(parent.id, "done", "operator", { human: true, cascade: true }))
        .toThrowError(/forced mid-cascade failure/);
    } finally {
      db.exec("DROP TRIGGER cascade_rollback_probe");
    }
    for (const id of [parent.id, mid.id, leaf.id]) {
      expect(store.getWorkItem(id)!.status).toBe("backlog");
    }
  });

  it("refuses over an escalated descendant, names it, and changes nothing", () => {
    const parent = store.createWorkItem({ title: "escalated parent" });
    const mid = store.createWorkItem({ title: "escalated mid", parentId: parent.id });
    const leaf = store.createWorkItem({ title: "escalated leaf", parentId: mid.id });
    transitions.transition(leaf.id, "escalated", "operator", { human: true });
    const refused = refusalOf(() => transitions.transition(parent.id, "done", "operator", { human: true, cascade: true }));
    expect(refused.code).toBe("escalated-descendant");
    expect(refused.message).toContain(leaf.id);
    expect(store.getWorkItem(parent.id)!.status).toBe("backlog");
    expect(store.getWorkItem(mid.id)!.status).toBe("backlog");
    expect(store.getWorkItem(leaf.id)!.status).toBe("escalated");
  });

  it("closes the same tree once the escalation is acknowledged", () => {
    const parent = store.createWorkItem({ title: "acknowledged parent" });
    const mid = store.createWorkItem({ title: "acknowledged mid", parentId: parent.id });
    const leaf = store.createWorkItem({ title: "acknowledged leaf", parentId: mid.id });
    transitions.transition(leaf.id, "escalated", "operator", { human: true });
    const result = transitions.transition(parent.id, "done", "operator", {
      human: true,
      cascade: true,
      acknowledgeEscalated: true,
    });
    expect(result.item.status).toBe("done");
    expect(store.getWorkItem(mid.id)!.status).toBe("done");
    expect(store.getWorkItem(leaf.id)!.status).toBe("done");
  });
});
