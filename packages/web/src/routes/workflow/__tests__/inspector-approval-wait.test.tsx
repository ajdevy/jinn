import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  api: {
    listLabels: () => Promise.resolve({ labels: [] }),
    getOrg: () => Promise.resolve({
      departments: ["platform"],
      employees: [
        {
          name: "platform-lead",
          displayName: "Platform Lead",
          department: "platform",
          rank: "manager",
          engine: "codex",
          model: "model",
          persona: "Platform lead",
        },
      ],
      hierarchy: { root: null, sorted: [], warnings: [] },
    }),
  },
}))

import type { WorkflowDefinitionWire, WorkflowNodeWire } from "@/lib/api"
import { Inspector } from "../editor/inspector"
import { createEditorStore, EditorStoreContext } from "../editor/store"

/** The config one node arm accepts. Each render helper below stands up a single
 *  node, so its config is that arm's — not a loose bag of keys. */
type NodeConfig<T extends WorkflowNodeWire["type"]> = Extract<WorkflowNodeWire, { type: T }>["config"]

/** `ui` is optional on the wire; this fixture is authored with one and the
 *  helpers below rewrite its positions. */
const definition: WorkflowDefinitionWire & { ui: NonNullable<WorkflowDefinitionWire["ui"]> } = {
  schemaVersion: 1,
  id: "morning-digest",
  title: "Morning Digest",
  revision: 3,
  enabled: false,
  createdAt: "2026-07-23T08:00:00.000Z",
  updatedAt: "2026-07-23T08:00:00.000Z",
  nodes: [{
    id: "writer",
    type: "employee",
    name: "Writer",
    config: {
      employee: { source: "fixed", value: "writer" },
      prompt: "",
    },
  }],
  edges: [],
  ui: { positions: { writer: { x: 0, y: 0 } } },
}

/** Stands the Inspector up on a one-node definition and selects that node. */
function renderOnly(node: WorkflowNodeWire) {
  const initial = structuredClone(definition)
  initial.nodes = [node]
  initial.ui.positions = { [node.id]: { x: 0, y: 0 } }
  const store = createEditorStore(initial)
  store.getState().selectNode(node.id)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <EditorStoreContext.Provider value={store}>
        <Inspector />
      </EditorStoreContext.Provider>
    </QueryClientProvider>,
  )
  return store
}

function renderApproval(config: NodeConfig<"approval">) {
  return renderOnly({ id: "gate", type: "approval", name: "Gate", config })
}

function renderWait(config: NodeConfig<"wait">) {
  return renderOnly({ id: "hold", type: "wait", name: "Ask operator", config })
}

function approvalConfig(store: ReturnType<typeof createEditorStore>) {
  return store.getState().nodes[0]!.data.node.config as Record<string, unknown>
}

describe("wait inspector todo-comment mode", () => {
  it("explains the mode read-only instead of offering controls that would drop it", () => {
    const config: NodeConfig<"wait"> = { mode: "todo-comment", timeoutMinutes: 10080 }
    const store = renderWait(config)

    expect(screen.getByText(/Resumes when you comment on the run/)).toBeTruthy()
    // Every control in this form replaces the whole config, so one appearing here
    // is the data loss itself: mode and timeout would be gone on first touch.
    expect(screen.queryByRole("combobox", { name: "Wait" })).toBeNull()
    expect(screen.queryByLabelText("Minutes")).toBeNull()
    expect(screen.queryByLabelText("Timestamp (ISO)")).toBeNull()
    expect(store.getState().nodes[0]!.data.node.config).toEqual(config)
    expect(store.getState().serial).toBe(0)
  })

  it("still edits a duration wait", () => {
    const store = renderWait({ mode: "duration", minutes: 60 })

    fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: "30" } })

    expect(store.getState().nodes[0]!.data.node.config).toEqual({ mode: "duration", minutes: 30 })
  })
})

describe("approval inspector operator-only gate", () => {
  it("reserves the gate and drops any approver, since the two contradict", () => {
    const store = renderApproval({ description: "Merge?", approver: { source: "fixed", value: "platform-lead" } })

    fireEvent.click(screen.getByLabelText("Only the operator may decide"))

    expect(approvalConfig(store)).toEqual({ description: "Merge?", operatorOnly: true })
    expect(screen.queryByLabelText("Approver (optional)")).toBeNull()
  })

  it("clears the flag entirely rather than writing operatorOnly: false", () => {
    const store = renderApproval({ description: "Merge?", operatorOnly: true })

    fireEvent.click(screen.getByLabelText("Only the operator may decide"))

    expect(approvalConfig(store)).not.toHaveProperty("operatorOnly")
    expect(screen.getByLabelText("Approver (optional)")).toBeTruthy()
  })
})

describe("approval inspector choices", () => {
  it("stays a plain approve/reject gate until choices are asked for", () => {
    const store = renderApproval({ description: "Merge?" })

    expect(screen.getByText("Approve or reject only.")).toBeTruthy()
    expect(screen.queryByLabelText("Choice 1")).toBeNull()
    expect(approvalConfig(store)).not.toHaveProperty("options")
  })

  it("opens the gate up with two labelled choices", () => {
    const store = renderApproval({ description: "Merge?" })

    fireEvent.click(screen.getByRole("button", { name: "Offer choices" }))

    expect(approvalConfig(store).options).toEqual(["Option 1", "Option 2"])
  })

  it("persists an edited label to the stored array", () => {
    const store = renderApproval({ description: "Merge?", options: ["Ship", "Hold"] })

    fireEvent.change(screen.getByLabelText("Choice 2"), { target: { value: "Hold for review" } })

    expect(approvalConfig(store).options).toEqual(["Ship", "Hold for review"])
  })

  it("appends a choice", () => {
    const store = renderApproval({ description: "Merge?", options: ["Ship", "Hold"] })

    fireEvent.click(screen.getByRole("button", { name: "Add choice" }))

    expect(approvalConfig(store).options).toEqual(["Ship", "Hold", "Option 3"])
  })

  it("offers no way past the schema's ceiling of eight", () => {
    renderApproval({
      description: "Merge?",
      options: ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"],
    })

    expect(screen.getAllByLabelText(/^Choice /)).toHaveLength(8)
    expect(screen.queryByRole("button", { name: "Add choice" })).toBeNull()
  })

  it("refuses to remove past the schema's floor of two", () => {
    const store = renderApproval({ description: "Merge?", options: ["Ship", "Hold"] })
    const remove = screen.getByRole("button", { name: "Remove choice 1" })

    expect(remove.hasAttribute("disabled")).toBe(true)
    fireEvent.click(remove)

    expect(approvalConfig(store).options).toEqual(["Ship", "Hold"])
  })

  it("removes a choice while more than two remain", () => {
    const store = renderApproval({ description: "Merge?", options: ["Ship", "Hold", "Ask"] })

    fireEvent.click(screen.getByRole("button", { name: "Remove choice 2" }))

    expect(approvalConfig(store).options).toEqual(["Ship", "Ask"])
  })

  it("drops the options key entirely rather than storing an empty list", () => {
    const store = renderApproval({ description: "Merge?", options: ["Ship", "Hold"] })

    fireEvent.click(screen.getByRole("button", { name: "Remove choices" }))

    expect(approvalConfig(store)).not.toHaveProperty("options")
    expect(screen.getByText("Approve or reject only.")).toBeTruthy()
  })
})
