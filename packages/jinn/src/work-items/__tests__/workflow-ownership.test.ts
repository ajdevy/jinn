import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-ownership-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Ownership = typeof import("../workflow-ownership.js");

let store: Store;
let ownership: Ownership;

beforeAll(async () => {
  store = await import("../store.js");
  ownership = await import("../workflow-ownership.js");
});

describe("owningWorkflowId", () => {
  it("is undefined when no Workflow has ever driven the Todo", () => {
    const item = store.createWorkItem({ title: "never ran a workflow" });
    expect(ownership.owningWorkflowId(item.id)).toBeUndefined();
  });

  it("returns the newest workflowId stamped on a status change", () => {
    const item = store.createWorkItem({ title: "moved pipelines", status: "assigned" });
    store.appendWorkItemEvent({
      workItemId: item.id, kind: "status_change", fromStatus: "assigned", toStatus: "executing",
      actor: "workflow:run", detail: { workflowId: "intake", runId: "run_1" }, versionEffect: "audit",
    });
    store.appendWorkItemEvent({
      workItemId: item.id, kind: "status_change", fromStatus: "executing", toStatus: "assigned",
      actor: "workflow:run", detail: { workflowId: "category", runId: "run_2" }, versionEffect: "audit",
    });
    expect(ownership.owningWorkflowId(item.id)).toBe("category");
  });
});
