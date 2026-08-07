import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire, WorkItemListWire, WorkItemStatusWire, WorkItemTreeWire } from "@/lib/api"
import TodoBoardPage from "../board/board-page"
import { isColumnInStatusFilter } from "../board/use-board"
import { clearBoardScrollCache } from "../board/board-route"

/* A board URL that names one status is a board of that one column. This is the
 * done-when of the Talk orb's open_todos: "executing todos I started" resolves
 * to /todos/b/my?status=executing, and that link has to render what it says. */

vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
vi.mock("@/components/ui/employee-avatar", () => ({ EmployeeAvatar: () => <span /> }))
vi.mock("@/hooks/use-gateway", () => ({ useGateway: () => ({ connectionSeq: 1, subscribe: () => () => {} }) }))

const listWorkItems = vi.fn()
const getWorkItemTrees = vi.fn()
const getDepartments = vi.fn()
const getOrg = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      listWorkItems: (...args: unknown[]) => listWorkItems(...args),
      getWorkItemTrees: (...args: unknown[]) => getWorkItemTrees(...args),
      getWorkItem: vi.fn().mockRejectedValue(new Error("not found")),
      getWorkItems: vi.fn().mockResolvedValue({ workItems: [] }),
      getWorkItemTree: vi.fn(),
      getDepartments: (...args: unknown[]) => getDepartments(...args),
      getOrg: (...args: unknown[]) => getOrg(...args),
      setWorkItemStatus: vi.fn(),
      updateWorkItem: vi.fn(),
      createWorkItem: vi.fn(),
      assignWorkItem: vi.fn(),
      decideWorkItemApproval: vi.fn(),
      escalateWorkItemApproval: vi.fn(),
    },
  }
})

function compact(id: string, status: WorkItemStatusWire): WorkItemCompactWire {
  return {
    id, status, version: 3, title: `Item ${id}`, assignee: null, department: "platform",
    source: "human", sourceRef: null, approvalState: null, approvalRequest: null,
    approvalRef: null, approvalTarget: null, approvalEscalatedAt: null, createdBy: "operator",
    parentId: null, rootId: id, depth: 0, dueAt: null, labels: [], blocked: false,
    updatedAt: "2026-07-23T08:00:00.000Z", rank: null,
  }
}

function tree(id: string): WorkItemTreeWire {
  return {
    root: {
      id, version: 3, title: `Item ${id}`, body: null, status: "executing", department: "platform",
      assignee: null, priority: 2, rank: null, source: "human", sourceRef: null, acceptance: null,
      verifyPolicy: null, rounds: 0, budgetUsd: null, approvalState: null, approvalRequest: null,
      approvalRef: null, approvalTarget: null, approvalEscalatedAt: null, approvalDecidedBy: null,
      approvalDecidedAt: null, createdAt: "2026-07-23T08:00:00.000Z",
      updatedAt: "2026-07-23T08:00:00.000Z", closedAt: null, children: [],
    },
    totals: { executing: 1 },
    spendUsd: 0,
  }
}

/** One operator Todo in backlog and one executing — the pair that tells an
 *  honestly-scoped board apart from one that just draws every column. */
const ROWS: Partial<Record<WorkItemStatusWire, WorkItemCompactWire[]>> = {
  backlog: [compact("PLA-1", "backlog")],
  executing: [compact("PLA-2", "executing")],
}

function listResponse(params: { status?: WorkItemStatusWire }): WorkItemListWire {
  const items = ROWS[params.status!] ?? []
  return { workItems: items, total: items.length, totals: { [params.status!]: items.length }, nextOffset: null }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearBoardScrollCache()
  sessionStorage.clear()
  listWorkItems.mockImplementation((params: { status?: WorkItemStatusWire }) => Promise.resolve(listResponse(params)))
  getWorkItemTrees.mockImplementation((ids: string[]) =>
    Promise.resolve({ trees: Object.fromEntries(ids.map((id) => [id, tree(id)])) }),
  )
  getDepartments.mockResolvedValue({ departments: [{ slug: "platform", prefix: "PLA", createdAt: "2026-07-01", todoCount: 2 }] })
  getOrg.mockResolvedValue({ departments: ["platform"], employees: [] })
})

function renderBoard(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/todos/b/:board" element={<TodoBoardPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe("isColumnInStatusFilter", () => {
  it("keeps every column on the default open board, closed ones included", () => {
    for (const status of ["backlog", "executing", "done", "cancelled"] as const) {
      expect(isColumnInStatusFilter("open", status)).toBe(true)
      expect(isColumnInStatusFilter("all", status)).toBe(true)
    }
  })

  it("keeps only the named column when the URL names one status", () => {
    expect(isColumnInStatusFilter("executing", "executing")).toBe(true)
    for (const status of ["backlog", "assigned", "in_review", "blocked", "escalated", "done", "cancelled"] as const) {
      expect(isColumnInStatusFilter("executing", status)).toBe(false)
    }
  })
})

describe("/todos/b/my?status=executing", () => {
  it("renders only the executing column, and only asks the gateway for it", async () => {
    renderBoard("/todos/b/my?status=executing")

    await waitFor(() => expect(screen.getByTestId("board-column-executing")).toBeTruthy())
    expect(screen.getAllByText("Item PLA-2").length).toBeGreaterThan(0)
    // The backlog Todo exists and is the operator's; it is simply not what the
    // link asked for. Before this scoping it rendered anyway.
    expect(screen.queryAllByText("Item PLA-1")).toEqual([])
    expect(screen.queryByTestId("board-column-backlog")).toBeNull()

    const asked = listWorkItems.mock.calls.map(([params]) => params).filter((params) => params?.status)
    expect(asked.map((params) => params.status)).toEqual(["executing"])
    // Board `my` is createdBy: operator — the other half of the done-when.
    expect(asked[0]).toMatchObject({ status: "executing", createdBy: "operator", rootsOnly: true })
  })

  it("still draws the whole pipeline with no status in the URL", async () => {
    renderBoard("/todos/b/my")

    await waitFor(() => expect(screen.getByTestId("board-column-backlog")).toBeTruthy())
    expect(screen.getByTestId("board-column-executing")).toBeTruthy()
    expect(screen.getAllByText("Item PLA-1").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Item PLA-2").length).toBeGreaterThan(0)
  })
})
