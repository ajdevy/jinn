import { describe, expect, it } from "vitest"
import type { WorkflowAttemptWire, WorkflowRunDetailWire, WorkflowRunLeanWire } from "@/lib/api"
import { mergeRunDetail, missingPromptAttempt } from "../run-support"

const STAMP = "2026-07-23T08:00:00.000Z"

function attempt(nodeId: string, number: number, promptText?: string): WorkflowAttemptWire {
  return {
    runId: "run-1", nodeId, attempt: number, status: "running",
    resolvedConfig: { employeeId: "a-lead", engine: "claude", retry: { attempts: 1, delaySeconds: 0, backoff: "fixed" } },
    startedAt: STAMP, remindersSent: 0, stopNudgesSent: 0, extensions: 0, lastProcessedTurn: 0,
    ...(promptText === undefined ? {} : { promptText }),
  }
}

const snapshot: WorkflowRunDetailWire = {
  id: "run-1", workflowId: "digest", workflowTitle: "Digest", definitionRevision: 3, revision: 4,
  definition: {
    schemaVersion: 1, id: "digest", title: "Digest", revision: 3, enabled: true,
    nodes: [{
      id: "writer", type: "employee", name: "Writer",
      config: { employee: { source: "fixed", value: "a-lead" }, prompt: "" },
    }],
    edges: [], createdAt: STAMP, updatedAt: STAMP,
  },
  status: "running", trigger: { nodeId: "trigger", kind: "manual", payload: {} }, input: {},
  spendUsd: 0, startedAt: STAMP,
  nodeRuns: [], attempts: [attempt("writer", 1, "First prompt.")], approvals: [], childRuns: [],
}

function lean(attempts: WorkflowAttemptWire[], overrides: Partial<WorkflowRunLeanWire> = {}): WorkflowRunLeanWire {
  const { definition: _definition, ...rest } = snapshot
  return { ...rest, attempts, ...overrides }
}

describe("mergeRunDetail", () => {
  it("carries the definition snapshot and known prompts onto a lean poll", () => {
    const merged = mergeRunDetail(snapshot, lean([attempt("writer", 1)], { status: "completed", revision: 9 }))

    expect(merged.definition).toEqual(snapshot.definition)
    expect(merged.status).toBe("completed")
    expect(merged.revision).toBe(9)
    expect(merged.attempts[0]?.promptText).toBe("First prompt.")
  })

  it("leaves an attempt the snapshot predates without a prompt", () => {
    const merged = mergeRunDetail(snapshot, lean([attempt("writer", 1), attempt("writer", 2)]))

    expect(merged.attempts[1]?.promptText).toBeUndefined()
  })

  it("keeps a prompt the caller already holds but the snapshot lacks", () => {
    const merged = mergeRunDetail(snapshot, lean([attempt("writer", 2, "Retried prompt.")]))

    expect(merged.attempts[0]?.promptText).toBe("Retried prompt.")
  })

  it("does not carry one node's prompt onto another node's same attempt number", () => {
    const merged = mergeRunDetail(snapshot, lean([attempt("reviewer", 1)]))

    expect(merged.attempts[0]?.promptText).toBeUndefined()
  })
})

describe("missingPromptAttempt", () => {
  it("names the latest attempt when its prompt is missing", () => {
    const detail = { ...snapshot, attempts: [attempt("writer", 1, "First prompt."), attempt("writer", 2)] }

    expect(missingPromptAttempt(detail, "writer")).toBe("writer:2")
  })

  it("is null when the latest prompt is known or the node has no attempts", () => {
    expect(missingPromptAttempt(snapshot, "writer")).toBeNull()
    expect(missingPromptAttempt(snapshot, "reviewer")).toBeNull()
  })
})
