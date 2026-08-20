import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { RouterProvider, createMemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

/* PLA-135 — a run carries attachments as refs, not bytes. The inspector's
 * output fields have to render those refs as the files they point at. */

const getWorkflowRun = vi.fn()
const getWorkflowRunFull = vi.fn()
const decideWorkflowApproval = vi.fn()
const getSession = vi.fn()

vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    constructor(readonly status: number, message: string, readonly code?: string) {
      super(message)
    }
  }
  return {
    ApiError,
    api: {
      getWorkflowRunV2: (...args: unknown[]) => getWorkflowRun(...args),
      getWorkflowRunFullV2: (...args: unknown[]) => getWorkflowRunFull(...args),
      decideWorkflowApprovalV2: (...args: unknown[]) => decideWorkflowApproval(...args),
      getSession: (...args: unknown[]) => getSession(...args),
      workItemAttachmentUrl: (id: string, attachmentId: string) => `/api/work-items/${id}/attachments/${attachmentId}`,
    },
  }
})
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@/context/breadcrumb-context", () => ({ useBreadcrumbs: () => undefined }))

import WorkflowRunPage from "../run"

const nodes = [
  { id: "trigger", type: "trigger", name: "Kickoff", config: { kind: "manual" } },
  { id: "writer", type: "employee", name: "Writer", config: { employee: { source: "fixed", value: "blog-writer" }, prompt: "Write it." } },
  { id: "fanout", type: "workflow-call", name: "Publish items", config: { workflowId: { source: "fixed", value: "publish-item" }, concurrency: 2 } },
  { id: "route", type: "condition", name: "Quality gate", config: { cases: [{ port: "case-1", label: "Good", all: [] }], defaultPort: "else" } },
  { id: "gate", type: "approval", name: "Publish gate", config: { description: "" } },
  { id: "hold", type: "wait", name: "Ask operator", config: { mode: "todo-comment", timeoutMinutes: 10080 } },
  { id: "finish", type: "end", name: "Done", config: { result: "success" } },
]

const edges = [
  { id: "e1", from: { nodeId: "trigger", port: "success" }, to: { nodeId: "writer", port: "input" } },
  { id: "e2", from: { nodeId: "writer", port: "success" }, to: { nodeId: "route", port: "input" } },
  { id: "e3", from: { nodeId: "route", port: "case-1" }, to: { nodeId: "gate", port: "input" } },
  { id: "e4", from: { nodeId: "gate", port: "approved" }, to: { nodeId: "finish", port: "input" } },
]

const positions = {
  trigger: { x: 0, y: 0 }, writer: { x: 300, y: 0 }, fanout: { x: 600, y: 0 }, route: { x: 900, y: 0 },
  gate: { x: 1200, y: 0 }, hold: { x: 1500, y: 0 }, finish: { x: 1800, y: 0 },
}

function nodeRun(nodeId: string, status: string, extra: Record<string, unknown> = {}) {
  const nodeType = nodes.find((node) => node.id === nodeId)!.type
  return { runId: "run-1", nodeId, nodeType, status, activated: true, startedAt: "2026-07-23T08:00:00.000Z", ...extra }
}

function baseDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1", workflowId: "morning-digest", workflowTitle: "Morning Digest",
    definitionRevision: 3, revision: 7,
    definition: { nodes, edges, ui: { positions } },
    status: "running",
    trigger: { nodeId: "trigger", kind: "manual" },
    startedAt: "2026-07-23T08:00:00.000Z",
    nodeRuns: [], attempts: [], approvals: [], childRuns: [],
    ...overrides,
  }
}

/** Serve the route's two shapes from one fixture: the fat payload the page
 *  fetches once, and the lean one it polls, which drops the definition snapshot
 *  and every attempt prompt. Serving both is what catches a panel that renders
 *  only because of a field the poll does not carry. */
function serveRun(detail: Record<string, unknown>) {
  getWorkflowRunFull.mockResolvedValue(detail)
  const lean = { ...detail }
  delete lean.definition
  lean.attempts = (detail.attempts as Array<Record<string, unknown>>).map((attempt) => {
    const polled = { ...attempt }
    delete polled.promptText
    delete polled.input
    return polled
  })
  getWorkflowRun.mockResolvedValue(lean)
}

function renderRun() {
  const router = createMemoryRouter(
    [{ path: "/workflow/:id/runs/:runId", element: <WorkflowRunPage /> }],
    { initialEntries: ["/workflow/morning-digest/runs/run-1"] },
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return client
}

beforeEach(() => {
  vi.clearAllMocks()
  getSession.mockResolvedValue({ status: "idle" })
})

describe("workflow run canvas", () => {
  it("renders attachment-ref output fields as previews rather than raw tokens", async () => {
    serveRun(baseDetail({
      nodeRuns: [
        nodeRun("trigger", "completed"),
        nodeRun("writer", "completed", {
          endedAt: "2026-07-23T08:03:00.000Z",
          input: {},
          output: { text: "", fields: {
            shot: "attachment:PLA-12:wia_ab12cd34ef56:image/png",
            extras: ["attachment:PLA-12:wia_00112233aabb:application/pdf"],
            summary: "Looks good",
          } },
        }),
      ],
    }))
    renderRun()
    fireEvent.click(await screen.findByText("Writer"))

    const inspector = within(await screen.findByTestId("run-inspector"))
    expect(inspector.getByTestId("attachment-ref-thumb-wia_ab12cd34ef56").querySelector("img")?.getAttribute("src"))
      .toBe("/api/work-items/PLA-12/attachments/wia_ab12cd34ef56?thumb=1")
    expect(inspector.getByTestId("attachment-ref-file-wia_00112233aabb").textContent).toContain("PDF")
    expect(inspector.getByText("Looks good")).toBeTruthy()
  })
})
