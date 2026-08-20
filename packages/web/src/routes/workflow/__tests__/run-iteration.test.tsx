import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { RouterProvider, createMemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

const getWorkflowRun = vi.fn()
const getWorkflowRunFull = vi.fn()

vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    constructor(readonly status: number, message: string, readonly code?: string) { super(message) }
  }
  return {
    ApiError,
    api: {
      getWorkflowRunV2: (...args: unknown[]) => getWorkflowRun(...args),
      getWorkflowRunFullV2: (...args: unknown[]) => getWorkflowRunFull(...args),
      decideWorkflowApprovalV2: vi.fn(),
      getSession: vi.fn(),
    },
  }
})
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@/context/breadcrumb-context", () => ({ useBreadcrumbs: () => undefined }))

import WorkflowRunPage from "../run"
import { edgeTaken } from "../run-canvas"

/**
 * A round is a whole child run, so the canvas has to count rounds rather than
 * fold them into one card, and the inspector has to name them as rounds.
 */

const nodes = [
  { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
  { id: "loop", type: "workflow-call", name: "Rework loop", config: {
    workflowId: { source: "fixed", value: "body-flow" }, concurrency: 1,
    iterate: { maxRounds: 3, continueWhile: [] },
  } },
  { id: "shipped", type: "end", name: "Shipped", config: { result: "success" } },
  { id: "escalated", type: "end", name: "Escalated", config: { result: "success" } },
]
const edges = [
  { id: "e1", from: { nodeId: "start", port: "success" }, to: { nodeId: "loop", port: "input" } },
  { id: "e2", from: { nodeId: "loop", port: "success" }, to: { nodeId: "shipped", port: "input" } },
  { id: "e3", from: { nodeId: "loop", port: "exhausted" }, to: { nodeId: "escalated", port: "input" } },
]
const positions = { start: { x: 0, y: 0 }, loop: { x: 300, y: 0 }, shipped: { x: 600, y: 0 }, escalated: { x: 600, y: 200 } }

function round(index: number, status: string, endOutput?: Record<string, unknown>, sessionId?: string) {
  return {
    nodeId: "loop", itemIndex: index, runId: `body-${index + 1}`, workflowId: "body-flow",
    status, startedAt: `2026-08-20T12:00:0${index}.000Z`,
    ...(endOutput ? { endOutput } : {}), ...(sessionId ? { sessionId } : {}),
  }
}

function serveRun(loopRun: Record<string, unknown>, childRuns: Array<Record<string, unknown>>) {
  const detail = {
    id: "run-1", workflowId: "loop-flow", workflowTitle: "Rework",
    definitionRevision: 1, revision: 4,
    definition: { nodes, edges, ui: { positions } },
    status: "running",
    trigger: { nodeId: "start", kind: "manual" },
    startedAt: "2026-08-20T12:00:00.000Z",
    nodeRuns: [
      { runId: "run-1", nodeId: "start", nodeType: "trigger", status: "completed", activated: true, startedAt: "2026-08-20T12:00:00.000Z" },
      { runId: "run-1", nodeId: "loop", nodeType: "workflow-call", activated: true, startedAt: "2026-08-20T12:00:00.000Z", ...loopRun },
    ],
    attempts: [], approvals: [], childRuns,
  }
  getWorkflowRunFull.mockResolvedValue(detail)
  const lean = { ...detail }
  delete (lean as Record<string, unknown>).definition
  getWorkflowRun.mockResolvedValue(lean)
}

function renderRun() {
  const router = createMemoryRouter(
    [{ path: "/workflow/:id/runs/:runId", element: <WorkflowRunPage /> }],
    { initialEntries: ["/workflow/loop-flow/runs/run-1"] },
  )
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  getWorkflowRun.mockReset()
  getWorkflowRunFull.mockReset()
})

describe("an iterating Workflow Call in a run", () => {
  it("counts rounds on the card while the loop is still going", async () => {
    serveRun(
      { status: "running", resolvedConfig: { workflowId: "body-flow", round: 2, maxRounds: 3 } },
      [round(0, "completed", { verdict: "rework" }), round(1, "running")],
    )
    renderRun()

    expect(await screen.findByText(/Round 2\/3 · Running/)).toBeTruthy()
  })

  it("keeps counting rounds once the loop settles, reading the round off its output", async () => {
    serveRun(
      { status: "completed", endedAt: "2026-08-20T12:09:00.000Z",
        output: { text: "", fields: { round: 3, maxRounds: 3, port: "exhausted", exhausted: true, last: { verdict: "rework" } } } },
      [round(0, "completed", { verdict: "rework" }), round(1, "completed", { verdict: "rework" }), round(2, "completed", { verdict: "rework" })],
    )
    renderRun()

    expect(await screen.findByText(/Round 3\/3 · Completed/)).toBeTruthy()
  })

  it("gives every round its own row, its own status and its own run to open", async () => {
    serveRun(
      { status: "running", resolvedConfig: { workflowId: "body-flow", round: 2, maxRounds: 3 } },
      [round(0, "completed", { verdict: "rework" }), round(1, "running")],
    )
    renderRun()

    fireEvent.click(await screen.findByText("Rework loop"))
    const inspector = within(await screen.findByTestId("run-inspector"))

    expect(inspector.getByText("Rounds · 2 of 3")).toBeTruthy()
    const links = inspector.getAllByRole("link", { name: /Round/ })
    expect(links.map((link) => link.textContent)).toEqual([
      expect.stringContaining("Round 1"),
      expect.stringContaining("Round 2"),
    ])
    expect(links[0]!.getAttribute("href")).toBe("/workflow/body-flow/runs/body-1")
    expect(links[1]!.getAttribute("href")).toBe("/workflow/body-flow/runs/body-2")
  })

  it("routes an exhausted loop down its exhausted lane, not down success", () => {
    const settled = (port: string) => ({
      runId: "run-1", nodeId: "loop", nodeType: "workflow-call" as const, status: "completed" as const,
      activated: true, startedAt: "2026-08-20T12:00:00.000Z",
      output: { text: "", fields: { round: 3, maxRounds: 3, port, exhausted: port === "exhausted" } },
    })

    expect(edgeTaken("workflow-call", settled("exhausted"), "exhausted")).toBe(true)
    expect(edgeTaken("workflow-call", settled("exhausted"), "success")).toBe(false)
    expect(edgeTaken("workflow-call", settled("success"), "success")).toBe(true)
    expect(edgeTaken("workflow-call", settled("success"), "exhausted")).toBe(false)

    // A call that does not iterate records no port and still leaves via success.
    const plain = { ...settled("success"), output: { text: "", fields: { total: 1, succeeded: 1 } } }
    expect(edgeTaken("workflow-call", plain, "success")).toBe(true)
  })

  it("shows what each round returned and the session it ran in", async () => {
    serveRun(
      { status: "running", resolvedConfig: { workflowId: "body-flow", round: 2, maxRounds: 3 } },
      [round(0, "completed", { verdict: "rework" }, "session-round-1"), round(1, "running")],
    )
    renderRun()

    fireEvent.click(await screen.findByText("Rework loop"))
    const inspector = within(await screen.findByTestId("run-inspector"))

    expect(inspector.getByText("verdict")).toBeTruthy()
    expect(inspector.getByText("rework")).toBeTruthy()
    const session = inspector.getByRole("link", { name: "session-round-1" })
    expect(session.getAttribute("href")).toBe("/?session=session-round-1")
  })
})
