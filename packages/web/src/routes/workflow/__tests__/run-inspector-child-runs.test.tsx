import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import { RouterProvider, createMemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  api: {
    listLabels: () => Promise.resolve({ labels: [] }),
    getOrg: () => Promise.resolve({ departments: [], employees: [], hierarchy: { root: null, sorted: [], warnings: [] } }),
  },
}))

import type { WorkflowChildRunWire, WorkflowRunDetailWire } from "@/lib/api"
import type { WorkflowNodeWire } from "../editor/ports"
import { RunInspector } from "../run-inspector"

const STARTED_AT = "2026-08-19T09:00:00.000Z"

function detailWith(node: WorkflowNodeWire, childRuns: WorkflowChildRunWire[]): WorkflowRunDetailWire {
  return {
    schemaVersion: 1, workflowId: "publish", id: "run_parent", status: "running",
    startedAt: STARTED_AT, endedAt: null, revision: 1,
    trigger: { kind: "manual", nodeId: node.id, payload: {} }, input: {},
    definition: {
      schemaVersion: 1, id: "publish", title: "Publish", revision: 1, enabled: true,
      createdAt: STARTED_AT, updatedAt: STARTED_AT,
      nodes: [node], edges: [], ui: { positions: { [node.id]: { x: 0, y: 0 } } },
    },
    nodeRuns: [{ nodeId: node.id, status: "running", activated: true, startedAt: STARTED_AT, endedAt: null }],
    attempts: [], approvals: [], childRuns,
  } as unknown as WorkflowRunDetailWire
}

function child(patch: Partial<WorkflowChildRunWire>): WorkflowChildRunWire {
  return { runId: "run_child", workflowId: "publish-item", nodeId: "fanout", status: "running", startedAt: STARTED_AT, ...patch }
}

function renderRun(detail: WorkflowRunDetailWire, nodeId: string) {
  const router = createMemoryRouter(
    [{
      path: "/",
      element: (
        <RunInspector detail={detail} nodeId={nodeId} onClose={() => undefined} onDecide={() => undefined} deciding={false} />
      ),
    }],
    { initialEntries: ["/"] },
  )
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

function hrefOf(label: string) {
  return screen.getByText(label).closest("a")?.getAttribute("href")
}

describe("child runs in the run inspector", () => {
  it("names a run an employee started by its workflow, not by an item it has no index in", () => {
    const node: WorkflowNodeWire = {
      id: "writer",
      type: "employee",
      name: "Writer",
      config: { employee: { source: "fixed", value: "writer" }, prompt: "" },
    }
    renderRun(detailWith(node, [child({ runId: "run_spawned", workflowId: "nightly-digest", nodeId: "writer" })]), "writer")

    expect(screen.getByText("nightly-digest")).toBeTruthy()
    expect(screen.queryByText(/^Item /)).toBeNull()
    expect(hrefOf("nightly-digest")).toBe("/workflow/nightly-digest/runs/run_spawned")
  })

  it("orders fan-out children by their item index, counting the first one as item 1", () => {
    const node: WorkflowNodeWire = {
      id: "fanout",
      type: "workflow-call",
      name: "Publish items",
      config: { workflowId: { source: "fixed", value: "publish-item" }, concurrency: 2 },
    }
    const detail = detailWith(node, [
      child({ runId: "run_second", itemIndex: 1 }),
      child({ runId: "run_first", itemIndex: 0 }),
    ])

    renderRun(detail, "fanout")

    expect(screen.getAllByText(/^Item /).map((el) => el.textContent)).toEqual(["Item 1", "Item 2"])
    expect(hrefOf("Item 1")).toBe("/workflow/publish-item/runs/run_first")
    expect(hrefOf("Item 2")).toBe("/workflow/publish-item/runs/run_second")
  })
})
