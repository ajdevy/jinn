import { describe, expect, it } from "vitest"
import type { WorkflowDefinitionWire, WorkflowNodeWire } from "@/lib/api"
import { serializeDefinition } from "../editor/graph"
import { createEditorStore } from "../editor/store"

/**
 * A serialized employee node has to carry back every field the gateway accepts,
 * including the ones the editor offers no control for. `mutex` is the case that
 * matters: it serializes a phase against a shared resource, and an editor that
 * dropped it on the operator's next unrelated edit would take the guard off a
 * running Workflow without anyone touching it.
 */

const workNode: WorkflowNodeWire = {
  id: "work", type: "employee", name: "Work",
  config: {
    employee: { source: "fixed", value: "worker" },
    prompt: "Do the guarded work.",
    mutex: "shared-resource",
  },
} as WorkflowNodeWire

const definition: WorkflowDefinitionWire = {
  schemaVersion: 1, id: "guarded-flow", title: "Guarded", revision: 2, enabled: true,
  createdAt: "2026-08-22T08:00:00.000Z", updatedAt: "2026-08-22T08:00:00.000Z",
  nodes: [
    { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
    workNode,
    { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
  ],
  edges: [
    { id: "e1", from: { nodeId: "start", port: "success" }, to: { nodeId: "work", port: "input" } },
    { id: "e2", from: { nodeId: "work", port: "success" }, to: { nodeId: "finish", port: "input" } },
  ],
} as WorkflowDefinitionWire

describe("authoring an employee node that holds a mutex", () => {
  it("saves the key back untouched after an unrelated edit", () => {
    const store = createEditorStore(structuredClone(definition))
    const current = store.getState().nodes.find((node) => node.id === "work")!.data.node

    // What the inspector does for every field it does own: spread the config, set one key.
    store.getState().replaceNode({ ...current, config: { ...current.config, prompt: "Do it carefully." } } as WorkflowNodeWire)

    const { meta, nodes, edges } = store.getState()
    const saved = serializeDefinition(meta, nodes, edges).nodes.find((node) => node.id === "work")!

    expect(saved.config).toMatchObject({ prompt: "Do it carefully.", mutex: "shared-resource" })
  })
})
