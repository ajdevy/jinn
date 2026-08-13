/**
 * What a long Todo list costs to scroll.
 *
 * The list windows above `VIRTUALIZE_THRESHOLD`, so these drive the page with
 * far more Todos than any window and assert the DOM never grows with the total.
 * Everything the reader can still do — collapse Closed, page a group, open a
 * row, narrow by status — is exercised THROUGH that windowed path, because a
 * bound nobody can interact with is not a fix.
 *
 * `installVirtualLayout` supplies the layout jsdom has none of; without it the
 * scrollport measures 0 and a windowed list renders nothing, which would make
 * every bound below pass for the wrong reason.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire, WorkItemListWire, WorkItemStatusWire } from "@/lib/api"
import { installVirtualLayout, type VirtualLayout } from "@/test/virtual-layout"
import TodoBoardPage from "../board/board-page"
import { clearBoardScrollCache } from "../board/board-route"

vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))

const listWorkItems = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      listWorkItems: (...args: unknown[]) => listWorkItems(...args),
      getWorkItemTrees: vi.fn().mockResolvedValue({ trees: {} }),
      getWorkItems: vi.fn().mockResolvedValue({ workItems: [] }),
      getDepartments: vi.fn().mockResolvedValue({
        departments: [{ slug: "platform", prefix: "PLA", createdAt: "2026-07-01", todoCount: 2 }],
      }),
      getOrg: vi.fn().mockResolvedValue({ departments: ["platform"], employees: [] }),
      createWorkItem: vi.fn(),
      assignWorkItem: vi.fn(),
      setWorkItemStatus: vi.fn(),
      updateWorkItem: vi.fn(),
      decideWorkItemApproval: vi.fn(),
      escalateWorkItemApproval: vi.fn(),
    },
  }
})

const BACKLOG_COUNT = 500
/** Enough to be windowed, cheap enough that the interaction tests stay quick. */
const SHORT_COUNT = 80
const ROW_H = 44
const VIEWPORT_H = 800
/** Window + overscan on both sides, generously rounded. Nowhere near 500. */
const WINDOW_CEILING = 40

const TARGETS = {
  scroller: '[data-testid="todo-list-scroll"]',
  row: '[data-testid^="todo-list-row-"]',
  rowId: "data-testid",
}

function compact(id: string, status: WorkItemStatusWire, rank: number): WorkItemCompactWire {
  return {
    id,
    version: 1,
    title: `Item ${id}`,
    status,
    assignee: null,
    department: "platform",
    source: "human",
    sourceRef: null,
    approvalState: null,
    approvalRequest: null,
    approvalRef: null,
    approvalTarget: null,
    approvalEscalatedAt: null,
    createdBy: "operator",
    parentId: null,
    rootId: id,
    depth: 0,
    dueAt: null,
    labels: [],
    blocked: false,
    updatedAt: "2026-07-31T08:00:00.000Z",
    rank,
  }
}

/** Deterministic order: ranks ascend, so the flat model is creation order. */
const BACKLOG = Array.from({ length: BACKLOG_COUNT }, (_, i) => compact(`PLA-${i}`, "backlog", i))
const SHORT_BACKLOG = BACKLOG.slice(0, SHORT_COUNT)
const DONE = [compact("PLA-900", "done", 0), compact("PLA-901", "done", 1)]
const ROW_IDS = BACKLOG.map((item) => `todo-list-row-${item.id}`)

let rows: Partial<Record<WorkItemStatusWire, WorkItemCompactWire[]>> = {}
let backlogHasMore = false

function response(params: { status?: WorkItemStatusWire; needsAttentionFor?: string }): WorkItemListWire {
  if (params.needsAttentionFor) return { workItems: [], total: 0, nextOffset: null }
  const items = rows[params.status!] ?? []
  const nextOffset = params.status === "backlog" && backlogHasMore ? items.length : null
  return { workItems: items, total: items.length, nextOffset, totals: { [params.status!]: items.length } }
}

function DetailProbe() {
  const navigate = useNavigate()
  return <button type="button" data-testid="detail-back" onClick={() => navigate(-1)}>Back</button>
}

function renderTodos(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/todos/b/:board" element={<TodoBoardPage />} />
          <Route path="/todos/:todoId" element={<DetailProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** The model index the page itself gave this row — read back, never recomputed. */
function modelIndexOf(rowTestId: string): number {
  const host = screen.getByTestId(rowTestId).closest<HTMLElement>("[data-index]")
  if (!host) throw new Error(`${rowTestId} is not inside a virtual row`)
  return Number(host.dataset.index)
}

let layout: VirtualLayout | null = null

// Five hundred Todos through the real page is a heavy render, and the default
// 5s runs out when this file shares the machine with the rest of the suite.
vi.setConfig({ testTimeout: 60_000 })

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  clearBoardScrollCache()
  rows = { backlog: BACKLOG, done: DONE }
  backlogHasMore = false
  listWorkItems.mockImplementation((params: { status?: WorkItemStatusWire; needsAttentionFor?: string }) =>
    Promise.resolve(response(params)),
  )
  layout = installVirtualLayout(ROW_H, VIEWPORT_H, TARGETS)
})

afterEach(() => {
  layout?.release()
  layout = null
})

describe("the windowed Todo list", () => {
  it("mounts a window of rows, not the whole backlog", async () => {
    renderTodos("/todos/b/platform")
    await screen.findByTestId("todo-list-row-PLA-0")

    const mounted = layout!.mountedRowIds()
    console.log(`[todo list] items=${BACKLOG_COUNT} mountedRows=${mounted.length}`)
    expect(mounted.length).toBeGreaterThan(0)
    expect(mounted.length).toBeLessThan(WINDOW_CEILING)
    // The bound is the window, not the data: the groups the window covers keep
    // their sections and quick-adds. Closed sits 500 rows below, so it is out
    // of the window here and comes back on scroll (the collapse test below).
    expect(screen.getByTestId("todo-list-group-needs-you")).toBeTruthy()
    expect(screen.getByTestId("todo-list-group-backlog")).toBeTruthy()
    expect(screen.getByTestId("todo-list-add-backlog")).toBeTruthy()
  })

  it("renders the correct slice of the flat model at a scrolled offset", async () => {
    renderTodos("/todos/b/platform")
    await screen.findByTestId("todo-list-row-PLA-0")
    const atTop = layout!.mountedRowIds()
    expect(atTop).toEqual(ROW_IDS.slice(0, atTop.length))

    const scrollTop = 6000
    layout!.scrollTo(scrollTop)
    await waitFor(() => expect(screen.queryByTestId("todo-list-row-PLA-0")).toBeNull())

    const mounted = layout!.mountedRowIds()
    const first = ROW_IDS.indexOf(mounted[0])
    console.log(`[todo list] scrollTop=${scrollTop} firstMountedItem=${first} mountedRows=${mounted.length}`)
    expect(first).toBeGreaterThan(0)
    expect(mounted.length).toBeLessThan(WINDOW_CEILING)
    // Contiguous, in order, and starting where the offset says it should.
    expect(mounted).toEqual(ROW_IDS.slice(first, first + mounted.length))
    // Every row left behind is gone, not merely scrolled out of sight.
    expect(mounted.some((id) => atTop.includes(id))).toBe(false)
    // And the slice is painted where the model puts it: a row's top edge is its
    // own model index times the row height, less how far the reader has scrolled.
    const probe = mounted[Math.floor(mounted.length / 2)]
    expect(layout!.offsetOf(probe)).toBe(modelIndexOf(probe) * ROW_H - scrollTop)
  })

  it("opens a row the window is showing", async () => {
    rows.backlog = SHORT_BACKLOG
    renderTodos("/todos/b/platform")
    await screen.findByTestId("todo-list-row-PLA-0")
    layout!.scrollTo(6000)
    await waitFor(() => expect(screen.queryByTestId("todo-list-row-PLA-0")).toBeNull())

    fireEvent.click(screen.getByTestId(layout!.mountedRowIds()[0]))
    await screen.findByTestId("detail-back")
  })

  it("collapses and re-opens Closed from the bottom of the window", async () => {
    rows.backlog = SHORT_BACKLOG
    renderTodos("/todos/b/platform")
    await screen.findByTestId("todo-list-row-PLA-0")
    layout!.scrollToBottom()
    const closed = await screen.findByTestId("todo-list-group-closed")

    const toggle = closed.querySelector<HTMLButtonElement>("button[aria-expanded]")!
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByTestId("todo-list-row-PLA-900")).toBeNull()

    fireEvent.click(toggle)
    layout!.scrollToBottom()
    await screen.findByTestId("todo-list-row-PLA-900")

    fireEvent.click(screen.getByTestId("todo-list-group-closed").querySelector<HTMLButtonElement>("button[aria-expanded]")!)
    await waitFor(() => expect(screen.queryByTestId("todo-list-row-PLA-900")).toBeNull())
  })

  it("pages a group from its Show more row", async () => {
    backlogHasMore = true
    rows.backlog = SHORT_BACKLOG
    renderTodos("/todos/b/platform")
    await screen.findByTestId("todo-list-row-PLA-0")
    layout!.scrollToBottom()

    fireEvent.click(await screen.findByTestId("todo-list-show-more-backlog"))
    await waitFor(() =>
      expect(listWorkItems).toHaveBeenCalledWith(expect.objectContaining({ status: "backlog", offset: SHORT_COUNT })),
    )
  })

  it("narrows to one status and keeps windowing that group", async () => {
    rows.backlog = SHORT_BACKLOG
    renderTodos("/todos/b/platform?status=backlog")
    await screen.findByTestId("todo-list-row-PLA-0")

    expect(screen.getByTestId("todo-list-group-backlog")).toBeTruthy()
    expect(screen.queryByTestId("todo-list-group-closed")).toBeNull()
    expect(layout!.mountedRowIds().length).toBeLessThan(WINDOW_CEILING)
  })
})
