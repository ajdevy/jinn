import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from JINN_HOME at module load). This keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-gw-resume-"));
process.env.JINN_HOME = tmp;

/* Where a resumed Todo actually lands: the status its own Workflow's trigger
 * fires on, with the arming label the trigger filters for. The sweep that
 * decides WHEN is tested in work-items/__tests__/availability-resume.test.ts. */

type Store = typeof import("../../work-items/store.js");
type Labels = typeof import("../../work-items/labels.js");
type Runs = typeof import("../../work-items/runs.js");
type Resume = typeof import("../../work-items/availability-resume.js");
type Port = typeof import("../availability-resume.js");

let store: Store;
let labels: Labels;
let runs: Runs;
let resume: Resume;
let port: Port;
let repository: import("../../workflows/repository.js").WorkflowRepository;
let workflows: Database.Database;

const NOW = new Date("2026-08-20T12:00:00.000Z");
const QUOTA = "Usage limit exceeded; try again at 2026-08-20T11:30:00.000Z";

/** An enabled workflow armed the way the build pipeline is: a label to carry and
 *  the operator's authority to start it. */
function armedWorkflow(id: string, config: { label?: string; actor?: string } = {}): void {
  const draft = repository.createDefinition({ id, title: id });
  const saved = repository.saveDefinition({
    ...draft,
    nodes: [
      { id: "start", type: "trigger", name: "Armed Todo", config: { kind: "todo-status", status: "assigned", ...config } },
      { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
    ],
    edges: [{ id: "start-finish", from: { nodeId: "start", port: "success" }, to: { nodeId: "finish", port: "input" } }],
  }, draft.revision);
  repository.setEnabled(id, true, saved.revision);
}

/** A Todo the given workflow was driving when a quota window killed its attempt. */
function parkedBy(workflowId: string | undefined, title: string, status: "executing" | "assigned" = "executing"): string {
  const item = store.createWorkItem({ title, status });
  const run = runs.openWorkItemRun({ workItemId: item.id, sessionId: `s-${item.id}` });
  runs.closeWorkItemRun(run.id, { outcome: "rate_limited", endedAt: new Date(NOW.getTime() - 90 * 60_000).toISOString(), error: QUOTA });
  if (workflowId !== undefined) {
    store.appendWorkItemEvent({
      workItemId: item.id, kind: "status_change", fromStatus: "assigned", toStatus: "executing",
      actor: "workflow:run", detail: { workflowId, runId: "run_1", nodeId: "plan" }, versionEffect: "audit",
    });
  }
  return item.id;
}

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  labels = await import("../../work-items/labels.js");
  runs = await import("../../work-items/runs.js");
  resume = await import("../../work-items/availability-resume.js");
  port = await import("../availability-resume.js");
  workflows = (await import("../../workflows/repository-migrations.js")).openWorkflowDatabase(path.join(tmp, "workflows.db"));
  repository = new (await import("../../workflows/repository.js")).WorkflowRepository(workflows);
  labels.createLabel({ name: "build" });
});

describe("resuming a Todo into its own trigger", () => {
  it("lands it on the trigger's status with the arming label back on it", () => {
    armedWorkflow("resume-build", { label: "build", actor: "operator" });
    const id = parkedBy("resume-build", "quota-killed build");
    expect(labels.getWorkItemLabels(id)).toHaveLength(0);

    const resumed = resume.sweepAvailabilityResumes({
      rearm: (todoId) => port.availabilityRearm(todoId, repository), now: () => NOW,
    });

    expect(resumed).toBe(1);
    expect(store.getWorkItem(id)?.status).toBe("assigned");
    expect(labels.getWorkItemLabels(id).map((label) => label.name)).toContain("build");
    const [event] = store.listWorkItemEvents(id).filter((e) => e.kind === "availability_resumed");
    expect(event?.detail).toMatchObject({ status: "assigned", label: "build" });
  });

  it("leaves a label the Todo already carries exactly as it is", () => {
    armedWorkflow("resume-labelled", { label: "build" });
    const id = parkedBy("resume-labelled", "still labelled");
    labels.setWorkItemLabels(id, ["build"], "operator");

    port.availabilityRearm(id, repository);

    expect(labels.getWorkItemLabels(id).map((label) => label.name)).toEqual(["build"]);
  });
});

describe("when nothing can be re-armed", () => {
  it("says so when no Workflow has ever driven the Todo", () => {
    const id = parkedBy(undefined, "never ran a workflow");

    expect(port.availabilityRearm(id, repository)).toMatchObject({
      unavailable: expect.stringContaining("no Workflow run has ever driven this Todo"),
    });
    expect(store.getWorkItem(id)?.status).toBe("executing");
  });

  it("says so when the Todo already sits at the status the trigger fires on", () => {
    // transitions.ts no-ops a same-status move, so nothing reaches the trigger.
    // Calling that a landing would spend this failure's one resume on it.
    armedWorkflow("resume-standing", { label: "build" });
    const id = parkedBy("resume-standing", "already at the arming status", "assigned");

    expect(port.availabilityRearm(id, repository)).toMatchObject({
      unavailable: expect.stringContaining("already `assigned`"),
    });
    expect(store.listWorkItemEvents(id).filter((e) => e.kind === "availability_resumed")).toHaveLength(0);
  });

  it("says so when the Workflow that drove it has since been disabled", () => {
    armedWorkflow("resume-disabled", { label: "build" });
    const definition = repository.getDefinition("resume-disabled");
    repository.setEnabled("resume-disabled", false, definition?.revision ?? 0);
    const id = parkedBy("resume-disabled", "workflow switched off");

    expect(port.availabilityRearm(id, repository)).toMatchObject({
      unavailable: expect.stringContaining("is disabled"),
    });
    expect(store.getWorkItem(id)?.status).toBe("executing");
  });
});
