import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry (SESSIONS_DB resolves from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-event-feed-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Labels = typeof import("../labels.js");
type Transitions = typeof import("../transitions.js");
type Feed = typeof import("../workflow-event-feed.js");

let store: Store;
let labels: Labels;
let tr: Transitions;
let feed: Feed;

beforeAll(async () => {
  store = await import("../store.js");
  labels = await import("../labels.js");
  tr = await import("../transitions.js");
  feed = await import("../workflow-event-feed.js");
});

describe("workflow Todo event feed", () => {
  it("carries the Todo's labels by id and name alongside the immutable provenance snapshot", () => {
    const review = labels.createLabel({ name: "Needs Review" });
    const item = store.createWorkItem({ title: "labelled todo", status: "executing", department: "platform", assignee: "worker" });
    labels.setWorkItemLabels(item.id, [review.id], "operator");
    tr.transition(item.id, "in_review", "worker");

    const pending = feed.createWorkflowTodoEventFeed({ ownerId: "test-owner" }).listPendingEvents();
    const event = pending.find((candidate) => candidate.workItemId === item.id);

    expect(event).toMatchObject({
      toStatus: "in_review",
      item: { source: "human", department: "platform", assignee: "worker", labels: [{ id: review.id, name: "needs-review" }] },
    });
  });

  it("carries the actor that performed the transition, including for rows written before the filter existed", () => {
    const item = store.createWorkItem({ title: "actor todo", status: "executing" });
    tr.transition(item.id, "in_review", "operator");
    // The audit row this test reads was written by the unchanged transition path,
    // so it stands in for every pre-existing event: `actor` is a first-class
    // column, never part of the provenance snapshot the replay shape-checks.
    const pending = feed.createWorkflowTodoEventFeed({ ownerId: "test-owner" }).listPendingEvents();

    expect(pending.find((candidate) => candidate.workItemId === item.id)!.actor).toBe("operator");
  });

  it("carries the arming-delegate stamp, and reads a missing or non-string one as unstamped", () => {
    const stamped = store.createWorkItem({ title: "delegate armed", status: "backlog" });
    tr.transition(stamped.id, "assigned", "session:delegate", { detail: { armedAsDelegate: "worker" } });
    const plain = store.createWorkItem({ title: "no stamp", status: "backlog" });
    tr.transition(plain.id, "assigned", "session:delegate");
    // Anything but a string is a detail written by something other than the
    // status route, so it grants nothing rather than reading as truthy.
    const malformed = store.createWorkItem({ title: "malformed stamp", status: "backlog" });
    tr.transition(malformed.id, "assigned", "session:delegate", { detail: { armedAsDelegate: { name: "worker" } } });

    const pending = feed.createWorkflowTodoEventFeed({ ownerId: "test-owner" }).listPendingEvents();
    const event = (id: string) => pending.find((candidate) => candidate.workItemId === id)!;

    expect(event(stamped.id)).toMatchObject({ actor: "session:delegate", armedAsDelegate: "worker" });
    expect(event(plain.id).armedAsDelegate).toBeNull();
    expect(event(malformed.id).armedAsDelegate).toBeNull();
  });

  it("reads an unlabelled Todo as an empty label set", () => {
    const item = store.createWorkItem({ title: "bare todo", status: "executing" });
    tr.transition(item.id, "in_review", "worker");

    const pending = feed.createWorkflowTodoEventFeed({ ownerId: "test-owner" }).listPendingEvents();

    expect(pending.find((candidate) => candidate.workItemId === item.id)!.item.labels).toEqual([]);
  });

  it("reads the assignee, parent, and status live, so a change after the status move is what the event carries", () => {
    const parent = store.createWorkItem({ title: "parent todo", status: "executing" });
    const child = store.createWorkItem({ title: "child todo", status: "executing", parentId: parent.id, assignee: "worker" });
    tr.transition(child.id, "in_review", "worker");
    // Same status, so this writes a `note` rather than a second pending event —
    // exactly the window a boot-time replay reads the Todo back in.
    tr.assignWorkItem(child.id, "other", null, "operator");

    const pending = feed.createWorkflowTodoEventFeed({ ownerId: "test-owner" }).listPendingEvents();
    const event = pending.find((candidate) => candidate.workItemId === child.id)!;

    expect(event.item.assignee).toBe("worker");
    expect(event.item.live).toEqual({ assignee: "other", parentId: parent.id, status: "in_review" });
  });

  it("reads a root Todo's live parent as null, and its status as where it stands now", () => {
    const item = store.createWorkItem({ title: "root todo", status: "executing" });
    tr.transition(item.id, "in_review", "worker");

    const pending = feed.createWorkflowTodoEventFeed({ ownerId: "test-owner" }).listPendingEvents();

    expect(pending.find((candidate) => candidate.workItemId === item.id)!.item.live)
      .toEqual({ assignee: null, parentId: null, status: "in_review" });
  });
});
