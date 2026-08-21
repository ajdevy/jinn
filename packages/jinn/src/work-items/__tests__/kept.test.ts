import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry (SESSIONS_DB resolves from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-kept-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Kept = typeof import("../kept.js");

let store: Store;
let kept: Kept;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  kept = await import("../kept.js");
  db = (await import("../../shared/db.js")).initDb();
});

const mk = (createdBy: string, extra: Record<string, unknown> = {}) =>
  store.createWorkItem({ title: `t-${Math.random().toString(36).slice(2, 8)}`, createdBy, ...extra });

/** What the Home board asks the gateway for. */
const homeIds = (extra: Record<string, unknown> = {}) =>
  store.queryWorkItems({ kept: true, rootsOnly: true, limit: 100, ...extra }).workItems.map((i) => i.id);

/* ICI-1357 — the operator's Home board. "My requests" was `createdBy=operator`,
 * which is exactly the set an agent-created Todo could never join. */
describe("creating a Todo keeps it when the operator is the creator", () => {
  it("puts the operator's own Todo on Home with no second call", () => {
    const mine = mk("operator");
    expect(kept.isWorkItemKept(db, mine.id)).toBe(true);
    expect(homeIds()).toContain(mine.id);
  });

  it("keeps a Todo an agent creates in the operator's name — the case that already worked", () => {
    // `delegate_task` mints in the operator's name; that Todo surfaced before
    // this change and has to keep surfacing.
    const onBehalf = store.createWorkItem({ title: "raised for the operator", source: "delegation", createdBy: "operator" });
    expect(homeIds()).toContain(onBehalf.id);
  });

  it("leaves an agent's own Todo off Home", () => {
    const theirs = mk("session:agent-1");
    expect(kept.isWorkItemKept(db, theirs.id)).toBe(false);
    expect(homeIds()).not.toContain(theirs.id);
  });

  it("defaults a machine-sourced Todo to `system`, which is not kept", () => {
    const cron = store.createWorkItem({ title: "nightly sweep", source: "cron", sourceRef: `cron:${Date.now()}` });
    expect(cron.createdBy).toBe("system");
    expect(kept.isWorkItemKept(db, cron.id)).toBe(false);
  });
});

/* Criterion 1: the whole point — an agent's Todo the operator wants to follow. */
describe("keeping an agent-created Todo puts it on Home, and unkeeping takes it off", () => {
  it("round-trips", () => {
    const theirs = mk("session:agent-2", { department: "platform" });
    expect(homeIds()).not.toContain(theirs.id);

    expect(kept.setWorkItemKept(db, theirs.id, true)).toBe(true);
    expect(homeIds()).toContain(theirs.id);

    expect(kept.setWorkItemKept(db, theirs.id, false)).toBe(true);
    expect(homeIds()).not.toContain(theirs.id);
  });

  it("reports no change on a repeat, so a caller can stay silent about one", () => {
    const item = mk("session:agent-3");
    expect(kept.setWorkItemKept(db, item.id, true)).toBe(true);
    expect(kept.setWorkItemKept(db, item.id, true)).toBe(false);
    expect(kept.setWorkItemKept(db, item.id, false)).toBe(true);
    expect(kept.setWorkItemKept(db, item.id, false)).toBe(false);
  });

  it("does not move a Todo that was already on Home", () => {
    const mine = mk("operator");
    const first = db.prepare("SELECT kept_at FROM work_item_kept WHERE work_item_id = ?").pluck().get(mine.id);
    kept.setWorkItemKept(db, mine.id, true);
    expect(db.prepare("SELECT kept_at FROM work_item_kept WHERE work_item_id = ?").pluck().get(mine.id)).toBe(first);
  });

  it("lets the operator drop their own Todo off Home without deleting it", () => {
    const mine = mk("operator");
    kept.setWorkItemKept(db, mine.id, false);
    expect(homeIds()).not.toContain(mine.id);
    expect(store.getWorkItem(mine.id)).toBeTruthy();
  });
});

describe("the kept filter composes with the board's other filters", () => {
  it("AND-composes with department and status", () => {
    const onPlatform = mk("operator", { department: "kept-platform", status: "backlog" });
    const elsewhere = mk("operator", { department: "kept-growth", status: "backlog" });
    const wrongStatus = mk("operator", { department: "kept-platform", status: "executing" });

    const ids = homeIds({ department: "kept-platform", status: "backlog" });
    expect(ids).toContain(onPlatform.id);
    expect(ids).not.toContain(elsewhere.id);
    expect(ids).not.toContain(wrongStatus.id);
  });

  it("counts the whole kept set, not the page", () => {
    const page = store.queryWorkItems({ kept: true, rootsOnly: true, limit: 1 });
    expect(page.workItems.length).toBe(1);
    expect(page.total).toBeGreaterThan(1);
  });

  it("shows sub-tasks only when the board is not asking for roots", () => {
    const parent = mk("operator");
    const child = store.createWorkItem({ title: "child", parentId: parent.id, createdBy: "operator" });
    expect(homeIds()).not.toContain(child.id);
    expect(store.queryWorkItems({ kept: true, limit: 100 }).workItems.map((i) => i.id)).toContain(child.id);
  });
});

describe("keptSet", () => {
  it("answers a whole page in one query, and is empty for none", () => {
    const mine = mk("operator");
    const theirs = mk("session:agent-4");
    expect(kept.keptSet(db, [mine.id, theirs.id])).toEqual(new Set([mine.id]));
    expect(kept.keptSet(db, [])).toEqual(new Set());
  });
});
