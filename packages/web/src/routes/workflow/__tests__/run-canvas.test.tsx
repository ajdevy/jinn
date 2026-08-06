import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { RouterProvider, createMemoryRouter } from "react-router-dom"
import { queryKeys } from "@/lib/query-keys"
import { beforeEach, describe, expect, it, vi } from "vitest"

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
    },
  }
})
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@/context/breadcrumb-context", () => ({ useBreadcrumbs: () => undefined }))

import { toFlowEdges, toFlowNodes } from "../editor/graph"
import { tidyLayout } from "../editor/layout"
import WorkflowRunPage from "../run"
import { AGENT_WRITTEN } from "./fixtures/specimen"

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

/** What use-query-invalidation does on a company:changed workflow-run frame. */
const runChanged = (c: QueryClient) => c.invalidateQueries({ queryKey: queryKeys.workflows.run("morning-digest", "run-1") })

function statusOf(name: string): string | null {
  const card = screen.getByText(name).closest("[data-node-status]")
  return card?.getAttribute("data-node-status") ?? null
}

/** Where the canvas actually placed a card, read off React Flow's transform. */
function positionOf(name: string): { x: number; y: number } {
  const wrapper = screen.getByText(name).closest(".react-flow__node") as HTMLElement | null
  const matched = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(wrapper?.style.transform ?? "")
  if (!matched) throw new Error(`node "${name}" is not placed on the canvas`)
  return { x: Number(matched[1]), y: Number(matched[2]) }
}

beforeEach(() => {
  vi.clearAllMocks()
  getSession.mockResolvedValue({ status: "idle" })
})

describe("workflow run canvas", () => {
  it("paints per-node statuses, including the derived waiting-submit state", async () => {
    serveRun(baseDetail({
      nodeRuns: [
        nodeRun("trigger", "completed", { endedAt: "2026-07-23T08:00:01.000Z" }),
        nodeRun("writer", "running"),
      ],
      attempts: [{
        runId: "run-1", nodeId: "writer", attempt: 1, sessionId: "sess-1", status: "running",
        startedAt: "2026-07-23T08:00:01.000Z", remindersSent: 1, nextReminderAt: "2026-07-23T08:20:00.000Z",
        extensions: 0,
      }],
    }))
    renderRun()

    expect(await screen.findByText("Writer")).toBeTruthy()
    expect(statusOf("Kickoff")).toBe("completed")
    expect(statusOf("Writer")).toBe("waiting-submit")
    expect(statusOf("Quality gate")).toBe("pending")
    expect(statusOf("Done")).toBe("pending")
  })

  it("keeps a running attempt without ladder activity as plain running", async () => {
    serveRun(baseDetail({
      nodeRuns: [nodeRun("trigger", "completed"), nodeRun("writer", "running")],
      attempts: [{
        runId: "run-1", nodeId: "writer", attempt: 1, sessionId: "sess-1", status: "running",
        startedAt: "2026-07-23T08:00:01.000Z", remindersSent: 0, extensions: 0,
      }],
    }))
    renderRun()

    expect(await screen.findByText("Writer")).toBeTruthy()
    expect(statusOf("Writer")).toBe("running")
  })

  it("shows workflow-call progress on the card and links every child run in item order", async () => {
    serveRun(baseDetail({
      nodeRuns: [
        nodeRun("trigger", "completed"),
        nodeRun("fanout", "running", { resolvedConfig: { workflowId: "publish-item", concurrency: 2, total: 3 } }),
      ],
      childRuns: [
        { nodeId: "fanout", itemIndex: 0, runId: "child-1", workflowId: "publish-item", status: "completed", startedAt: "2026-07-23T08:00:01.000Z", endOutput: { slug: "first" } },
        { nodeId: "fanout", itemIndex: 1, runId: "child-2", workflowId: "publish-item", status: "running", startedAt: "2026-07-23T08:00:02.000Z" },
      ],
    }))
    renderRun()

    expect(await screen.findByText(/1\/3 · Running/)).toBeTruthy()
    fireEvent.click(screen.getByText("Publish items"))

    const inspector = within(await screen.findByTestId("run-inspector"))
    const links = inspector.getAllByRole("link", { name: /Item/ })
    expect(links.map((link) => link.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Item 1"), expect.stringContaining("Item 2")]))
    expect(links[0]!.getAttribute("href")).toBe("/workflow/publish-item/runs/child-1")
    expect(links[1]!.getAttribute("href")).toBe("/workflow/publish-item/runs/child-2")
  })

  it("captions a todo-comment wait by its mode, never as a duration it has none of", async () => {
    serveRun(baseDetail({ nodeRuns: [nodeRun("trigger", "completed")] }))
    renderRun()

    expect(await screen.findByText("On your comment")).toBeTruthy()
    expect(screen.queryByText("? min")).toBeNull()
  })

  it("shows the Todo a parked comment-wait needs, on the card and in the inspector", async () => {
    serveRun(baseDetail({
      status: "waiting",
      nodeRuns: [
        nodeRun("trigger", "completed"),
        nodeRun("hold", "waiting", {
          resolvedConfig: { mode: "todo-comment", todoId: "PLA-68", timeoutMinutes: 10080 },
          resumeAt: "2026-07-30T08:00:00.000Z",
        }),
      ],
    }))
    const client = renderRun()

    expect(await screen.findByText("waiting for your comment on PLA-68 · 7d")).toBeTruthy()
    // The lean poll drops the definition, not resolvedConfig — the caption has to
    // survive a refresh that is served entirely from the polled shape.
    await runChanged(client)
    await waitFor(() => expect(getWorkflowRun).toHaveBeenCalled(), { timeout: 4000 })
    expect(screen.getByText("waiting for your comment on PLA-68 · 7d")).toBeTruthy()

    fireEvent.click(screen.getByText("Ask operator"))

    const inspector = within(await screen.findByTestId("run-inspector"))
    expect(inspector.getByText(/Waiting for your comment on PLA-68 · times out/)).toBeTruthy()
    expect(inspector.queryByText(/Resumes/)).toBeNull()
  }, 10000)

  it("stops asking for a comment once the wait has resumed", async () => {
    // The node keeps its resolvedConfig and resumeAt after it resumes, so a
    // settled comment-wait must not still read as parked on either surface.
    serveRun(baseDetail({
      nodeRuns: [
        nodeRun("trigger", "completed"),
        nodeRun("hold", "completed", {
          resolvedConfig: { mode: "todo-comment", todoId: "PLA-68", timeoutMinutes: 10080 },
          resumeAt: "2026-07-30T08:00:00.000Z",
          endedAt: "2026-07-23T09:00:00.000Z",
        }),
      ],
    }))
    renderRun()

    expect(await screen.findByText("On your comment")).toBeTruthy()
    expect(screen.queryByText(/waiting for your comment/)).toBeNull()

    fireEvent.click(screen.getByText("Ask operator"))

    const inspector = within(await screen.findByTestId("run-inspector"))
    expect(inspector.queryByText(/Waiting for your comment/)).toBeNull()
    expect(inspector.queryByText(/Resumes/)).toBeNull()
  })

  it("marks failed nodes and dims skipped ones", async () => {
    serveRun(baseDetail({
      status: "failed",
      nodeRuns: [
        nodeRun("trigger", "completed"),
        nodeRun("writer", "failed", { error: { code: "workflow-no-output", message: "No output.", retryable: true } }),
        nodeRun("route", "skipped", { activated: false }),
      ],
    }))
    renderRun()

    expect(await screen.findByText("Writer")).toBeTruthy()
    expect(statusOf("Writer")).toBe("failed")
    expect(statusOf("Quality gate")).toBe("skipped")
  })

  it("opens the run inspector with output fields, attempts, and the session link", async () => {
    serveRun(baseDetail({
      nodeRuns: [
        nodeRun("trigger", "completed"),
        nodeRun("writer", "completed", {
          endedAt: "2026-07-23T08:03:00.000Z",
          input: {},
          output: { text: "Digest **drafted**.", fields: { summary: "Looks good", count: 2 }, sessionId: "sess-1" },
        }),
      ],
      attempts: [{
        runId: "run-1", nodeId: "writer", attempt: 1, sessionId: "sess-1", status: "completed",
        resolvedConfig: { employeeId: "blog-writer", engine: "claude", model: "opus", effort: "high" },
        promptText: "Write the digest.\n\n---\nContract block.",
        output: { text: "Digest **drafted**.", fields: { summary: "Looks good", count: 2 } },
        startedAt: "2026-07-23T08:00:01.000Z", endedAt: "2026-07-23T08:03:00.000Z",
        remindersSent: 2, extensions: 1, lastExtensionReason: "Waiting on a child session.",
      }],
    }))
    renderRun()

    // fireEvent.click, not userEvent: userEvent also dispatches mousedown into
    // the canvas pane, which trips d3-zoom on jsdom (event.view is null there).
    fireEvent.click(await screen.findByText("Writer"))

    const inspector = within(await screen.findByTestId("run-inspector"))
    expect(inspector.getByText("summary")).toBeTruthy()
    expect(inspector.getByText("Looks good")).toBeTruthy()
    expect(inspector.getByText("drafted")).toBeTruthy()
    expect(inspector.getByText("blog-writer")).toBeTruthy()
    expect(inspector.getByText("Effort")).toBeTruthy()
    expect(inspector.getByText("high")).toBeTruthy()
    expect(inspector.getByText(/Write the digest\./)).toBeTruthy()
    expect(inspector.getByText("No input")).toBeTruthy()
    expect(inspector.getByText(/2 reminders sent/)).toBeTruthy()
    expect(inspector.getByText(/1 extension/)).toBeTruthy()
    expect(inspector.getByText(/Waiting on a child session/)).toBeTruthy()
    const link = inspector.getByRole("link", { name: /open chat session/i })
    expect(link.getAttribute("href")).toBe("/?session=sess-1")
  })

  it("collapses a long prompt behind a disclosure", async () => {
    const longPrompt = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n")
    serveRun(baseDetail({
      nodeRuns: [nodeRun("trigger", "completed"), nodeRun("writer", "running")],
      attempts: [{
        runId: "run-1", nodeId: "writer", attempt: 1, sessionId: "sess-1", status: "running",
        resolvedConfig: { employeeId: "blog-writer", engine: "claude" },
        promptText: longPrompt,
        startedAt: "2026-07-23T08:00:01.000Z", remindersSent: 0, extensions: 0,
      }],
    }))
    renderRun()

    fireEvent.click(await screen.findByText("Writer"))

    const inspector = within(await screen.findByTestId("run-inspector"))
    expect(inspector.queryByText(/line 30/)).toBeNull()
    await userEvent.click(inspector.getByRole("button", { name: /show prompt · 30 lines/i }))
    expect(inspector.getByText(/line 30/)).toBeTruthy()
  })

  it("shows an approval node's decision in the inspector", async () => {
    serveRun(baseDetail({
      nodeRuns: [nodeRun("trigger", "completed"), nodeRun("gate", "completed", { output: { text: "", fields: { port: "approved" } } })],
      approvals: [{
        runId: "run-1", nodeId: "gate", status: "approved", requestedAt: "2026-07-23T08:01:00.000Z",
        decidedAt: "2026-07-23T08:02:00.000Z", decidedBy: "operator", decision: "approve",
      }],
    }))
    renderRun()

    fireEvent.click(await screen.findByText("Publish gate"))

    const inspector = within(await screen.findByTestId("run-inspector"))
    expect(inspector.getByText(/Approved by operator/)).toBeTruthy()
  })

  it("approves a pending approval from the inspector with the run's revision", async () => {
    const pending = baseDetail({
      status: "waiting",
      nodeRuns: [nodeRun("trigger", "completed"), nodeRun("gate", "waiting")],
      approvals: [{ runId: "run-1", nodeId: "gate", status: "pending", requestedAt: "2026-07-23T08:01:00.000Z" }],
    })
    serveRun(pending)
    const approved = {
      ...pending,
      status: "running",
      approvals: [{ ...pending.approvals[0] as object, status: "approved", decidedBy: "operator", decidedAt: "2026-07-23T08:05:00.000Z" }],
    }
    decideWorkflowApproval.mockImplementation(() => {
      serveRun(approved)
      return Promise.resolve(approved)
    })
    renderRun()

    fireEvent.click(await screen.findByText("Publish gate"))
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }))

    await waitFor(() => expect(decideWorkflowApproval).toHaveBeenCalledWith(
      "morning-digest", "run-1", "gate", { decision: "approve", expectedRevision: 7 },
    ))
    expect(await screen.findByText(/Approved by operator/)).toBeTruthy()
  })

  it("fetches the snapshot once and keeps the canvas painted off lean refreshes", async () => {
    serveRun(baseDetail({ nodeRuns: [nodeRun("trigger", "completed"), nodeRun("writer", "running")] }))
    const client = renderRun()

    expect(await screen.findByText("Writer")).toBeTruthy()
    // A run event refreshes the run; it must not pay for the definition snapshot again.
    await runChanged(client)
    await waitFor(() => expect(getWorkflowRun).toHaveBeenCalled(), { timeout: 4000 })
    expect(getWorkflowRunFull).toHaveBeenCalledTimes(1)
    expect(screen.getByText("Quality gate")).toBeTruthy()
  }, 10000)

  it("re-fetches the snapshot when a node is opened whose prompt it predates", async () => {
    const attempt = (number: number, promptText?: string) => ({
      runId: "run-1", nodeId: "writer", attempt: number, sessionId: "sess-1", status: "running",
      resolvedConfig: { employeeId: "blog-writer", engine: "claude" },
      startedAt: "2026-07-23T08:00:01.000Z", remindersSent: 0, extensions: 0,
      ...(promptText === undefined ? {} : { promptText }),
    })
    const nodeRuns = [nodeRun("trigger", "completed"), nodeRun("writer", "running")]
    // The page loaded before a retry, so its snapshot only knows attempt 1.
    getWorkflowRunFull
      .mockResolvedValueOnce(baseDetail({ nodeRuns, attempts: [attempt(1, "First prompt.")] }))
      .mockResolvedValue(baseDetail({ nodeRuns, attempts: [attempt(1, "First prompt."), attempt(2, "Retried prompt.")] }))
    const lean = baseDetail({ nodeRuns, attempts: [attempt(1), attempt(2)] }) as Record<string, unknown>
    delete lean.definition
    getWorkflowRun.mockResolvedValue(lean)
    const client = renderRun()

    fireEvent.click(await screen.findByText("Writer"))
    await runChanged(client)

    // The retry surfaces on the event-driven lean refresh; opening the node then
    // pulls the prompt the snapshot predates, instead of dropping it silently.
    const inspector = within(await screen.findByTestId("run-inspector"))
    expect(await inspector.findByText(/Retried prompt\./, {}, { timeout: 6000 })).toBeTruthy()
    expect(getWorkflowRunFull).toHaveBeenCalledTimes(2)
  }, 10000)

  it("lays out a definition whose positions were written by an agent, not arranged by hand", async () => {
    serveRun(baseDetail({ nodeRuns: [nodeRun("trigger", "completed")] }))
    renderRun()

    expect(await screen.findByText("Writer")).toBeTruthy()
    // The stored y is 0 for every node, so a tidied graph must move the branches off it.
    expect(positionOf("Quality gate")).not.toEqual(positions.route)
    expect(positionOf("Writer").x).toBeGreaterThan(positionOf("Kickoff").x)
    expect(positionOf("Done").x).toBeGreaterThan(positionOf("Publish gate").x)
  })

  it("paints the 23-node specimen on tidyLayout's placement, not its agent-written one", async () => {
    serveRun(baseDetail({
      definition: { nodes: AGENT_WRITTEN.nodes, edges: AGENT_WRITTEN.edges, ui: AGENT_WRITTEN.ui },
      nodeRuns: [],
    }))
    renderRun()

    expect(await screen.findByText("Item arrives")).toBeTruthy()
    const tidied = tidyLayout(toFlowNodes(AGENT_WRITTEN), toFlowEdges(AGENT_WRITTEN))
    expect(tidied).toHaveLength(23)
    const painted = Object.fromEntries(tidied.map((node) => [node.id, positionOf(node.data.node.name)]))
    expect(painted).toEqual(Object.fromEntries(tidied.map((node) => [node.id, node.position])))
    expect(painted).not.toEqual(AGENT_WRITTEN.ui.positions)
  }, 10000)

  it("keeps a hand-arranged definition on its exact stored coordinates", async () => {
    serveRun(baseDetail({
      definition: { nodes, edges, ui: { positions, layout: "manual" } },
      nodeRuns: [nodeRun("trigger", "completed")],
    }))
    renderRun()

    expect(await screen.findByText("Writer")).toBeTruthy()
    expect(positionOf("Kickoff")).toEqual(positions.trigger)
    expect(positionOf("Quality gate")).toEqual(positions.route)
    expect(positionOf("Done")).toEqual(positions.finish)
  })

  it("re-tidies a hand-arranged definition once a node arrives without a position", async () => {
    const { finish: _finish, ...partial } = positions
    serveRun(baseDetail({
      definition: { nodes, edges, ui: { positions: partial, layout: "manual" } },
      nodeRuns: [nodeRun("trigger", "completed")],
    }))
    renderRun()

    expect(await screen.findByText("Writer")).toBeTruthy()
    expect(positionOf("Done")).not.toEqual({ x: 0, y: 0 })
    expect(positionOf("Done").x).toBeGreaterThan(positionOf("Publish gate").x)
  })

  it("renders the run header without any editing affordances", async () => {
    serveRun(baseDetail({
      status: "completed", endedAt: "2026-07-23T08:05:00.000Z",
      nodeRuns: nodes.map((node) => nodeRun(node.id, "completed")),
    }))
    renderRun()

    expect(await screen.findByText("Manual run")).toBeTruthy()
    expect(screen.getByText("Kickoff")).toBeTruthy()
    // Editor-only chrome must be absent from the run view.
    expect(screen.queryByText("Add step")).toBeNull()
    expect(screen.queryByLabelText(/Insert node on connection/)).toBeNull()
    expect(screen.queryByLabelText(/Add node after/)).toBeNull()
  })
})
