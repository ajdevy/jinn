import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  api: {
    listLabels: () => Promise.resolve({ labels: [] }),
    getOrg: () => Promise.resolve({ departments: [], employees: [], hierarchy: { root: null, sorted: [], warnings: [] } }),
  },
}))

import type { WorkflowNodeWire, WorkflowRunDetailWire } from "@/lib/api"
import { Inspector } from "../editor/inspector"
import { createEditorStore, EditorStoreContext } from "../editor/store"
import { RunInspector } from "../run-inspector"

const PLANNED_DEGREE = { source: "node", nodeId: "plan", path: "fields.degree" } as const

type WorkflowCallConfig = Extract<WorkflowNodeWire, { type: "workflow-call" }>["config"]

function renderEditor(config: WorkflowCallConfig) {
  const store = createEditorStore({
    schemaVersion: 1, id: "publish", title: "Publish", revision: 1, enabled: false,
    createdAt: "2026-08-05T12:00:00.000Z", updatedAt: "2026-08-05T12:00:00.000Z",
    nodes: [{ id: "fanout", type: "workflow-call", name: "Publish items", config }],
    edges: [],
    ui: { positions: { fanout: { x: 0, y: 0 } } },
  })
  store.getState().selectNode("fanout")
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <EditorStoreContext.Provider value={store}><Inspector /></EditorStoreContext.Provider>
    </QueryClientProvider>,
  )
  return store
}

function renderRun(resolvedConfig: Record<string, unknown>) {
  const detail = {
    schemaVersion: 1, workflowId: "publish", id: "run_1", status: "running",
    startedAt: "2026-08-05T12:00:00.000Z", endedAt: null, revision: 1,
    trigger: { kind: "manual", nodeId: "start", payload: {} }, input: {},
    definition: {
      schemaVersion: 1, id: "publish", title: "Publish", revision: 1, enabled: true,
      createdAt: "2026-08-05T12:00:00.000Z", updatedAt: "2026-08-05T12:00:00.000Z",
      nodes: [{ id: "fanout", type: "workflow-call", name: "Publish items", config: { workflowId: { source: "fixed", value: "publish-item" } } }],
      edges: [], ui: { positions: { fanout: { x: 0, y: 0 } } },
    },
    nodeRuns: [{ nodeId: "fanout", status: "running", activated: true, startedAt: "2026-08-05T12:00:00.000Z", endedAt: null, resolvedConfig }],
    attempts: [], approvals: [], childRuns: [],
  } as unknown as WorkflowRunDetailWire
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RunInspector detail={detail} nodeId="fanout" onClose={() => undefined} onDecide={() => undefined} deciding={false} />
    </QueryClientProvider>,
  )
}

describe("workflow-call concurrency in the editor", () => {
  it("keeps an authored planner binding when another field is edited", () => {
    const store = renderEditor({
      workflowId: { source: "fixed", value: "publish-item" },
      concurrency: PLANNED_DEGREE,
    })

    fireEvent.change(within(screen.getByText("Workflow").parentElement!).getByLabelText("Fixed value"), {
      target: { value: "publish-post" },
    })

    expect(store.getState().nodes[0]!.data.node.config).toEqual({
      workflowId: { source: "fixed", value: "publish-post" },
      concurrency: PLANNED_DEGREE,
    })
  })

  it("shows a planner binding as one, rather than as a blank number", () => {
    renderEditor({ workflowId: { source: "fixed", value: "publish-item" }, concurrency: PLANNED_DEGREE })

    const field = within(screen.getByText("Concurrency").parentElement!)

    expect((field.getByLabelText("Path") as HTMLInputElement).value).toBe("fields.degree")
    expect(field.queryByLabelText("Fixed value")).toBeNull()
  })
})

describe("fan-out width in the run inspector", () => {
  it("says only the one number when nothing was clamped", () => {
    renderRun({ workflowId: "publish-item", total: 5, concurrency: 4, concurrencyEffective: 4, concurrencyLimitedBy: "requested" })

    expect(screen.getByText("4 at a time")).toBeTruthy()
  })

  it("says what was asked for and what the machine allowed", () => {
    renderRun({ workflowId: "publish-item", total: 5, concurrency: 6, concurrencyEffective: 3, concurrencyLimitedBy: "system-ceiling" })

    expect(screen.getByText("6 requested · 3 at a time (system ceiling)")).toBeTruthy()
  })
})
