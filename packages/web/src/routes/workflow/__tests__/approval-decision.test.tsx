import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { RouterProvider, createMemoryRouter } from "react-router-dom"
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

import WorkflowRunPage from "../run"

const OPTIONS = ["Ship it", "Hold for review", "Ship to beta"]

const nodes = [
  { id: "trigger", type: "trigger", name: "Kickoff", config: { kind: "manual" } },
  { id: "gate", type: "approval", name: "Publish gate", config: { description: "", options: OPTIONS } },
  { id: "plain", type: "approval", name: "Legal gate", config: { description: "" } },
  { id: "finish", type: "end", name: "Done", config: { result: "success" } },
]

const edges = [
  { id: "e1", from: { nodeId: "trigger", port: "success" }, to: { nodeId: "gate", port: "input" } },
  { id: "e2", from: { nodeId: "gate", port: "approved" }, to: { nodeId: "plain", port: "input" } },
  { id: "e3", from: { nodeId: "plain", port: "approved" }, to: { nodeId: "finish", port: "input" } },
]

const positions = { trigger: { x: 0, y: 0 }, gate: { x: 300, y: 0 }, plain: { x: 600, y: 0 }, finish: { x: 900, y: 0 } }

function pendingDetail() {
  return {
    id: "run-1", workflowId: "morning-digest", workflowTitle: "Morning Digest",
    definitionRevision: 3, revision: 7,
    definition: { nodes, edges, ui: { positions } },
    status: "waiting",
    trigger: { nodeId: "trigger", kind: "manual" },
    startedAt: "2026-07-23T08:00:00.000Z",
    nodeRuns: [
      { runId: "run-1", nodeId: "trigger", nodeType: "trigger", status: "completed", activated: true, startedAt: "2026-07-23T08:00:00.000Z" },
      { runId: "run-1", nodeId: "gate", nodeType: "approval", status: "waiting", activated: true, startedAt: "2026-07-23T08:01:00.000Z" },
      { runId: "run-1", nodeId: "plain", nodeType: "approval", status: "waiting", activated: true, startedAt: "2026-07-23T08:01:00.000Z" },
    ],
    attempts: [],
    approvals: [
      { runId: "run-1", nodeId: "gate", status: "pending", requestedAt: "2026-07-23T08:01:00.000Z" },
      { runId: "run-1", nodeId: "plain", status: "pending", requestedAt: "2026-07-23T08:01:00.000Z" },
    ],
    childRuns: [],
  }
}

/** The run page fetches the fat payload once and polls the lean one, which
 *  drops the definition snapshot — the only place the gate's options live. */
function serveRun(detail: Record<string, unknown>) {
  getWorkflowRunFull.mockResolvedValue(detail)
  const lean = { ...detail }
  delete lean.definition
  getWorkflowRun.mockResolvedValue(lean)
}

/** Open the inspector on one gate and hand back a scope over the panel. */
async function openGate(name: string) {
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
  fireEvent.click(await screen.findByText(name))
  return within(await screen.findByTestId("run-inspector"))
}

const decisionBody = () => decideWorkflowApproval.mock.calls[0]?.[3] as Record<string, unknown>

describe("approval decision", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    serveRun(pendingDetail())
    decideWorkflowApproval.mockImplementation(() => Promise.resolve(pendingDetail()))
  })

  it("offers every declared option and holds Approve until one is picked", async () => {
    const inspector = await openGate("Publish gate")

    const picker = inspector.getByRole("radiogroup", { name: "Choose an option" })
    expect(within(picker).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(OPTIONS)
    expect(inspector.getByRole("button", { name: "Approve" })).toHaveProperty("disabled", true)

    await userEvent.click(within(picker).getByRole("radio", { name: "Hold for review" }))

    expect(within(picker).getByRole("radio", { name: "Hold for review" }).getAttribute("aria-checked")).toBe("true")
    expect(inspector.getByRole("button", { name: /^Approve/ })).toHaveProperty("disabled", false)
  })

  it("sends the picked option, and nothing the operator did not write", async () => {
    const inspector = await openGate("Publish gate")

    await userEvent.click(inspector.getByRole("radio", { name: "Ship to beta" }))
    await userEvent.click(inspector.getByRole("button", { name: /^Approve/ }))

    await waitFor(() => expect(decideWorkflowApproval).toHaveBeenCalledWith(
      "morning-digest", "run-1", "gate", { decision: "approve", expectedRevision: 7, choice: "Ship to beta" },
    ))
    expect(Object.keys(decisionBody()).sort()).toEqual(["choice", "decision", "expectedRevision"])
  })

  it("sends the reason typed alongside an approval", async () => {
    const inspector = await openGate("Publish gate")

    await userEvent.click(inspector.getByRole("radio", { name: "Ship it" }))
    await userEvent.type(inspector.getByRole("textbox", { name: "Reason" }), "Numbers check out")
    await userEvent.click(inspector.getByRole("button", { name: /^Approve/ }))

    await waitFor(() => expect(decideWorkflowApproval).toHaveBeenCalledWith(
      "morning-digest", "run-1", "gate", {
        decision: "approve", expectedRevision: 7, reason: "Numbers check out", choice: "Ship it",
      },
    ))
  })

  it("rejects with a reason and without a pick", async () => {
    const inspector = await openGate("Publish gate")

    await userEvent.type(inspector.getByRole("textbox", { name: "Reason" }), "Source is stale")
    await userEvent.click(inspector.getByRole("button", { name: "Reject" }))

    await waitFor(() => expect(decideWorkflowApproval).toHaveBeenCalledWith(
      "morning-digest", "run-1", "gate", { decision: "reject", expectedRevision: 7, reason: "Source is stale" },
    ))
  })

  it("carries neither the pick nor the reason from one gate to the next", async () => {
    const inspector = await openGate("Publish gate")

    await userEvent.click(inspector.getByRole("radio", { name: "Ship it" }))
    await userEvent.type(inspector.getByRole("textbox", { name: "Reason" }), "Reason from the publish gate")

    fireEvent.click(await screen.findByText("Legal gate"))
    const next = within(await screen.findByTestId("run-inspector"))

    expect(next.getByRole("textbox", { name: "Reason" })).toHaveProperty("value", "")
    // An exact "Approve" is the assertion: a label reading "Approve · Ship it"
    // is a choice this gate never offered, waiting to be sent to the route.
    await userEvent.click(next.getByRole("button", { name: "Approve" }))

    await waitFor(() => expect(decideWorkflowApproval).toHaveBeenCalledWith(
      "morning-digest", "run-1", "plain", { decision: "approve", expectedRevision: 7 },
    ))
  })

  it("shows no picker, and approves straight away, when the gate declares no options", async () => {
    const inspector = await openGate("Legal gate")

    expect(inspector.queryByRole("radiogroup")).toBeNull()
    await userEvent.click(inspector.getByRole("button", { name: "Approve" }))

    await waitFor(() => expect(decideWorkflowApproval).toHaveBeenCalledWith(
      "morning-digest", "run-1", "plain", { decision: "approve", expectedRevision: 7 },
    ))
    expect(Object.keys(decisionBody()).sort()).toEqual(["decision", "expectedRevision"])
  })
})
