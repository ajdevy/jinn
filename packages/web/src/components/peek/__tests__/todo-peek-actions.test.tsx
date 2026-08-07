import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError, type WorkItemStatusWire } from "@/lib/api"
import { legalTargets } from "@/lib/legal-targets"
import { STATUS_LABEL } from "@/lib/todos"
import { TODO_WRITE_KEY } from "@/lib/query-keys"
import { TodoPrefixContext } from "@/components/chat/todo-prefix-context"
import { TodoMention } from "@/components/todo-mention"
import { PeekPanel } from "../peek-panel"
import { PeekProvider } from "../peek-stack"
import { detailOf } from "./peek-fixtures"

/* ICI-743 — the peek rail's quick actions. The pickers are the task page's, so
 * what is proved here is the wiring: one write per choice, the row moving before
 * the gateway answers, the gateway's own words when it refuses, and the phone
 * stacking that puts the picker above the panel it was opened from. */

const getWorkItem = vi.fn()
const getWorkItems = vi.fn()
const getWorkItemTree = vi.fn()
const setWorkItemStatus = vi.fn()
const assignWorkItem = vi.fn()
const updateWorkItem = vi.fn()
const realMatchMedia = window.matchMedia

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getWorkItem: (...args: unknown[]) => getWorkItem(...args),
      getWorkItems: (...args: unknown[]) => getWorkItems(...args),
      getWorkItemTree: (...args: unknown[]) => getWorkItemTree(...args),
      setWorkItemStatus: (...args: unknown[]) => setWorkItemStatus(...args),
      assignWorkItem: (...args: unknown[]) => assignWorkItem(...args),
      updateWorkItem: (...args: unknown[]) => updateWorkItem(...args),
      getOrg: () => Promise.resolve({
        departments: ["platform"],
        employees: [
          { name: "a-lead", displayName: "A Lead", department: "platform", rank: "senior", engine: "codex", model: "m", persona: "p" },
          { name: "b-lead", displayName: "B Lead", department: "platform", rank: "senior", engine: "codex", model: "m", persona: "p" },
        ],
        hierarchy: { root: null, sorted: [], warnings: [] },
      }),
    },
  }
})

vi.mock("@/hooks/use-gateway", () => ({
  useGateway: () => ({ connectionSeq: 1, subscribe: () => () => {} }),
}))

let client: QueryClient

function renderChat() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <MemoryRouter initialEntries={["/chat"]}>
      <QueryClientProvider client={client}>
        <TodoPrefixContext.Provider value={new Set(["ICI"])}>
          <PeekProvider>
            <TodoMention id="ICI-1" />
            <PeekPanel />
          </PeekProvider>
        </TodoPrefixContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

function atSheetBreakpoint() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: true, media: "", addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  })
}

async function openPanel() {
  fireEvent.click(screen.getByRole("link", { name: "ICI-1" }))
  await screen.findByTestId("peek-todo")
}

/** Open a property's picker and wait for its rows to be there to click. */
async function openPicker(property: "status" | "assignee") {
  fireEvent.click(screen.getByTestId(`peek-row-${property}`))
  await screen.findByTestId(
    property === "status" ? "status-option-done" : "assignee-option-unassign",
  )
}

function statusRowText(): string {
  return screen.getByTestId("peek-prop-status").textContent ?? ""
}

function assigneeRowText(): string {
  return screen.getByTestId("peek-prop-assignee").textContent ?? ""
}

/** The tree behind the close gate: `openKids` children still in flight. */
function treeOf(openKids: number) {
  return {
    tree: {
      root: {
        ...detailOf("ICI-1").workItem,
        children: [
          ...Array.from({ length: openKids }, (_, i) => ({ ...detailOf(`ICI-2${i}`).workItem, children: [] })),
          { ...detailOf("ICI-30").workItem, status: "done" as WorkItemStatusWire, children: [] },
        ],
      },
      totals: {},
      spendUsd: 0,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  getWorkItem.mockImplementation((id: string) => Promise.resolve(detailOf(id)))
  getWorkItems.mockImplementation((ids: string[]) =>
    Promise.resolve({ workItems: ids.map((id) => ({ workItem: { id, title: `Title of ${id}` }, events: [] })) }))
  getWorkItemTree.mockResolvedValue(treeOf(0))
  setWorkItemStatus.mockResolvedValue({ workItem: { ...detailOf("ICI-1").workItem, version: 5 }, escalated: false })
  assignWorkItem.mockResolvedValue({ workItem: { ...detailOf("ICI-1").workItem, version: 5, assignee: "b-lead" } })
  updateWorkItem.mockResolvedValue({ workItem: { ...detailOf("ICI-1").workItem, version: 5, assignee: null }, replayed: false })
})

afterEach(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: realMatchMedia })
})

describe("peek status quick action", () => {
  it("writes the chosen transition once and moves the row before the gateway answers", async () => {
    let resolveWrite!: (value: unknown) => void
    setWorkItemStatus.mockImplementation(() => new Promise((resolve) => { resolveWrite = resolve }))
    renderChat()
    await openPanel()
    await openPicker("status")

    fireEvent.click(screen.getByTestId("status-option-in_review"))

    await waitFor(() => expect(statusRowText()).toContain("In review"))
    expect(setWorkItemStatus).toHaveBeenCalledTimes(1)
    // The third argument is the optional transition note, which the peek has no
    // affordance for; the route omits it from the body when it is undefined.
    expect(setWorkItemStatus).toHaveBeenCalledWith("ICI-1", "in_review", undefined)

    resolveWrite({ workItem: { ...detailOf("ICI-1").workItem, version: 5, status: "in_review" }, escalated: false })
    await waitFor(() => expect(statusRowText()).toContain("In review"))
  })

  it("offers exactly the legal targets, and nothing outside them", async () => {
    getWorkItem.mockImplementation((id: string) => Promise.resolve(detailOf(id, { status: "in_review" })))
    renderChat()
    await openPanel()
    await openPicker("status")

    const offered = legalTargets("in_review", { openChildren: 0 })
      .filter((target) => target.status !== "in_review")
      .map((target) => target.status)
    for (const status of offered) {
      expect(screen.getByTestId(`status-option-${status}`)).toBeTruthy()
    }
    // Everything else is absent — the current value's own row aside, which is
    // the checked "you are here" row rather than a target.
    const rendered = screen.getAllByRole("menuitem").map((row) => row.getAttribute("data-testid"))
    expect(rendered.sort()).toEqual(["status-option-in_review", ...offered.map((s) => `status-option-${s}`)].sort())
  })

  it("keeps a close-gated target visible but disabled, with the gateway's reason", async () => {
    getWorkItemTree.mockResolvedValue(treeOf(2))
    renderChat()
    await openPanel()
    await openPicker("status")

    const done = screen.getByTestId("status-option-done")
    expect(done.getAttribute("aria-disabled")).toBe("true")
    expect(done.textContent).toContain("2 sub-tasks still open")

    fireEvent.click(done)
    expect(setWorkItemStatus).not.toHaveBeenCalled()
  })

  it("returns the row to its previous status and says why the gateway refused", async () => {
    // A refusal with no mapped code, so what the operator reads is the gateway's
    // own sentence rather than a house translation of it.
    const refusal = "the dispatcher is holding this Todo"
    setWorkItemStatus.mockRejectedValue(new ApiError(403, refusal))
    renderChat()
    await openPanel()
    await openPicker("status")

    fireEvent.click(screen.getByTestId("status-option-in_review"))

    await waitFor(() => expect(screen.getByTestId("peek-action-error").textContent).toBe(refusal))
    expect(statusRowText()).toContain("Executing")
  })
})

describe("peek assignee quick action", () => {
  it("assigns through the roster-validated route and shows the new name at once", async () => {
    let resolveWrite!: (value: unknown) => void
    assignWorkItem.mockImplementation(() => new Promise((resolve) => { resolveWrite = resolve }))
    renderChat()
    await openPanel()
    await openPicker("assignee")

    fireEvent.click(screen.getByTestId("assignee-option-b-lead"))

    await waitFor(() => expect(assigneeRowText()).toContain("B Lead"))
    expect(assignWorkItem).toHaveBeenCalledWith("ICI-1", "b-lead")
    // The in-flight write holds the key use-query-invalidation defers behind, so
    // a live company:changed cannot land on top of the optimistic value.
    expect(client.isMutating({ mutationKey: TODO_WRITE_KEY })).toBeGreaterThan(0)

    resolveWrite({ workItem: { ...detailOf("ICI-1").workItem, version: 5, assignee: "b-lead" } })
    await waitFor(() => expect(client.isMutating({ mutationKey: TODO_WRITE_KEY })).toBe(0))
  })

  it("unassigns through the conditional edit lane, carrying the item's version", async () => {
    let resolveWrite!: (value: unknown) => void
    updateWorkItem.mockImplementation(() => new Promise((resolve) => { resolveWrite = resolve }))
    renderChat()
    await openPanel()
    await openPicker("assignee")

    fireEvent.click(screen.getByTestId("assignee-option-unassign"))

    await waitFor(() => expect(assigneeRowText()).toContain("Unassigned"))
    expect(assignWorkItem).not.toHaveBeenCalled()
    expect(updateWorkItem).toHaveBeenCalledWith("ICI-1", expect.objectContaining({
      patch: { assignee: null },
      expectedVersion: 4,
    }))
    expect(client.isMutating({ mutationKey: TODO_WRITE_KEY })).toBeGreaterThan(0)

    resolveWrite({ workItem: { ...detailOf("ICI-1").workItem, version: 5, assignee: null }, replayed: false })
    await waitFor(() => expect(client.isMutating({ mutationKey: TODO_WRITE_KEY })).toBe(0))
  })

  it("rolls the name back and repeats the gateway's suggestion when the roster refuses", async () => {
    const refusal = 'unknown employee "b-lead". Did you mean "b-leed"?'
    assignWorkItem.mockRejectedValue(new ApiError(400, refusal))
    renderChat()
    await openPanel()
    await openPicker("assignee")

    fireEvent.click(screen.getByTestId("assignee-option-b-lead"))

    await waitFor(() => expect(screen.getByTestId("peek-action-error").textContent).toBe(refusal))
    expect(assigneeRowText()).toContain("A Lead")
  })
})

describe("peek pickers on the phone", () => {
  it("puts the picker sheet above the peek sheet and lets Escape close it first", async () => {
    atSheetBreakpoint()
    renderChat()
    await openPanel()
    expect(screen.getByTestId("peek-sheet")).toBeTruthy()

    fireEvent.click(screen.getByTestId("peek-row-status"))
    const picker = await screen.findByTestId("peek-picker-sheet-status")
    const peekLayer = screen.getByTestId("peek-sheet").parentElement
    expect(peekLayer?.className).toContain("z-[100]")
    expect(picker.parentElement?.className).toContain("z-[120]")

    fireEvent.keyDown(picker, { key: "Escape" })

    await waitFor(() => expect(screen.queryByTestId("peek-picker-sheet-status")).toBeNull())
    expect(screen.getByTestId("peek-sheet")).toBeTruthy()

    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("peek-sheet")).toBeNull())
  })

  it("stands the sheet's Tab ring down while a picker is open above it", async () => {
    atSheetBreakpoint()
    renderChat()
    await openPanel()
    fireEvent.click(screen.getByTestId("peek-row-status"))
    await screen.findByTestId("peek-picker-sheet-status")

    const dismiss = screen.getByRole("button", { name: "Dismiss" })
    dismiss.focus()
    fireEvent.keyDown(dismiss, { key: "Tab", shiftKey: true })

    expect(document.activeElement).toBe(dismiss)
  })
})

describe("peek read-only properties", () => {
  it("leaves Priority and Parent without a picker", async () => {
    renderChat()
    await openPanel()

    for (const property of ["priority", "parent"]) {
      expect(screen.getByTestId(`peek-prop-${property}`).querySelector("[aria-haspopup]")).toBeNull()
    }
    expect(screen.getByTestId("peek-prop-status").querySelector("[aria-haspopup]")).toBeTruthy()
    expect(screen.getByText(STATUS_LABEL.executing)).toBeTruthy()
  })
})
