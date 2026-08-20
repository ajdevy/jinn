import { describe, expect, it } from "vitest"
import type { WorkflowDefinitionV2Wire } from "@/lib/api"
import { outputPorts } from "../editor/ports"
import { createEditorStore } from "../editor/store"

/**
 * Authoring an iterating Workflow Call. The `exhausted` route is the escalation
 * lane a bounded loop is refused without, so the editor has to offer the handle
 * and must never quietly drop a wire already hanging off it.
 */

const iterate = { maxRounds: 2, continueWhile: [{ left: { source: "node", nodeId: "loop", path: "fields.last.verdict" }, operator: "equals", right: { source: "fixed", value: "rework" } }] }

function definition(loopConfig: Record<string, unknown>): WorkflowDefinitionV2Wire {
  return {
    schemaVersion: 1, id: "loop-flow", title: "Loop", revision: 1, enabled: false,
    createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
    nodes: [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      { id: "loop", type: "workflow-call", name: "Loop", config: loopConfig },
      { id: "shipped", type: "end", name: "Shipped", config: { result: "success" } },
      { id: "escalated", type: "end", name: "Escalated", config: { result: "success" } },
    ],
    edges: [
      { id: "e1", from: { nodeId: "start", port: "success" }, to: { nodeId: "loop", port: "input" } },
      { id: "e2", from: { nodeId: "loop", port: "success" }, to: { nodeId: "shipped", port: "input" } },
      { id: "e3", from: { nodeId: "loop", port: "exhausted" }, to: { nodeId: "escalated", port: "input" } },
    ],
  } as WorkflowDefinitionV2Wire
}

const call = { workflowId: { source: "fixed", value: "body-flow" }, concurrency: 1 }

function loopNode(config: Record<string, unknown>) {
  return { id: "loop", type: "workflow-call", name: "Loop", config } as never
}

function edgeIds(store: ReturnType<typeof createEditorStore>): string[] {
  return store.getState().edges.map((edge) => edge.id)
}

describe("authoring an iterating Workflow Call", () => {
  it("offers an exhausted handle only once the call iterates, and keeps success first", () => {
    expect(outputPorts(loopNode(call)).map((port) => port.id)).toEqual(["success"])

    const ports = outputPorts(loopNode({ ...call, iterate }))
    expect(ports.map((port) => port.id)).toEqual(["success", "exhausted"])
    expect(ports[1]).toMatchObject({ label: "exhausted", wall: "bottom" })
  })

  it("keeps the exhausted wire when the loop is edited, and drops it only when iteration is turned off", () => {
    const store = createEditorStore(definition({ ...call, iterate }))

    store.getState().updateNodeConfig("loop", { ...call, iterate: { ...iterate, maxRounds: 3 } })
    expect(edgeIds(store)).toContain("e3")

    // Turning iteration off removes the port, so its wire goes with it — the
    // existing Condition-case behaviour, now that the port set is dynamic.
    store.getState().updateNodeConfig("loop", call)
    expect(edgeIds(store)).not.toContain("e3")
    expect(edgeIds(store)).toContain("e2")
  })
})
