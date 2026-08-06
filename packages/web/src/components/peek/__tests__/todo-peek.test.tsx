import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { GatewayEvent, GatewayEventListener } from "@jinn/gateway-events"
import type { WorkItemDetailWire, WorkItemEventWire } from "@/lib/api"
import { TodoPrefixContext } from "@/components/chat/todo-prefix-context"
import { TodoMention } from "@/components/todo-mention"
import { useQueryInvalidation } from "@/hooks/use-query-invalidation"
import { PeekPanel } from "../peek-panel"
import { PeekProvider } from "../peek-stack"

const getWorkItem = vi.fn()
const getWorkItems = vi.fn()
const realMatchMedia = window.matchMedia
let listener: ((event: string, payload: unknown) => void) | undefined

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getWorkItem: (...args: unknown[]) => getWorkItem(...args),
      getWorkItems: (...args: unknown[]) => getWorkItems(...args),
      getOrg: () => Promise.resolve({ employees: [], departments: [] }),
    },
  }
})

vi.mock("@/hooks/use-gateway", () => ({
  useGateway: () => ({
    connectionSeq: 1,
    subscribe: (next: (event: string, payload: unknown) => void) => {
      const typedNext = next as unknown as GatewayEventListener
      listener = (event, payload) => typedNext({ event, payload } as GatewayEvent)
      return () => { listener = undefined }
    },
  }),
}))

/** Five distinct whispers, oldest first — the order the gateway sends. */
const EVENTS: WorkItemEventWire[] = [
  ["created", "created this todo"],
  ["label_changed", "changed the labels"],
  ["relation_added", "linked a related todo"],
  ["session_linked", "linked a session"],
  ["attachment_removed", "removed an attachment"],
].map(([kind], index) => ({
  id: `e${index + 1}`,
  workItemId: "ICI-1",
  kind,
  fromStatus: null,
  toStatus: null,
  actor: "a-lead",
  detail: null,
  createdAt: `2026-08-0${index + 1}T00:00:00.000Z`,
}))

const BODY = "A body long enough to want clamping across three lines."

function detailOf(id: string, overrides: Partial<WorkItemDetailWire["workItem"]> = {}): WorkItemDetailWire {
  return {
    workItem: {
      id,
      title: `Title of ${id}`,
      body: BODY,
      status: "executing",
      department: null,
      assignee: "a-lead",
      priority: 3,
      rank: null,
      source: "human",
      sourceRef: null,
      acceptance: null,
      verifyPolicy: null,
      rounds: 0,
      budgetUsd: null,
      approvalState: null,
      approvalRequest: null,
      approvalRef: null,
      approvalTarget: null,
      approvalEscalatedAt: null,
      approvalDecidedBy: null,
      approvalDecidedAt: null,
      // Only ICI-1 has a parent, so following it does not loop back on itself.
      parentId: id === "ICI-1" ? "ICI-9" : null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
      closedAt: null,
      ...overrides,
    },
    spendUsd: 0,
    events: EVENTS,
  }
}

function renderChat() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  function Harness() {
    useQueryInvalidation()
    return (
      <PeekProvider>
        <TodoMention id="ICI-1" />
        <PeekPanel />
      </PeekProvider>
    )
  }
  return render(
    <MemoryRouter initialEntries={["/chat"]}>
      <QueryClientProvider client={client}>
        <TodoPrefixContext.Provider value={new Set(["ICI"])}>
          <Harness />
        </TodoPrefixContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

/** Click the mention the way a person does, then let the detail query land. */
async function openPanel() {
  fireEvent.click(screen.getByRole("link", { name: "ICI-1" }))
  await screen.findByTestId("peek-todo")
}

function activityLines(): string[] {
  return [...screen.getByTestId("peek-activity").children].map((row) => row.textContent ?? "")
}

beforeEach(() => {
  getWorkItem.mockReset()
  getWorkItem.mockImplementation((id: string) => Promise.resolve(detailOf(id)))
  getWorkItems.mockReset()
  getWorkItems.mockImplementation((ids: string[]) =>
    Promise.resolve({ workItems: ids.map((id) => ({ workItem: { id, title: `Title of ${id}` }, events: [] })) }))
})

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(window, "matchMedia", { configurable: true, value: realMatchMedia })
})

describe("peek panel contents", () => {
  it("shows the Todo the gateway returned, not the mention text", async () => {
    renderChat()
    await openPanel()

    expect(getWorkItem).toHaveBeenCalledWith("ICI-1")
    expect(screen.getByRole("heading", { name: "Title of ICI-1" })).toBeTruthy()
    expect(screen.getByText(BODY).className).toContain("line-clamp-3")
    for (const label of ["status", "assignee", "priority", "parent"]) {
      expect(screen.getByTestId(`peek-prop-${label}`)).toBeTruthy()
    }
    expect(activityLines()).toHaveLength(3)
  })

  it("shows the three newest events, newest first", async () => {
    renderChat()
    await openPanel()

    const lines = activityLines()
    expect(lines[0]).toContain("removed an attachment")
    expect(lines[1]).toContain("linked a session")
    expect(lines[2]).toContain("linked a related todo")
    expect(lines.join(" ")).not.toContain("created this todo")
  })

  it("pulses the newest row only while the Todo is executing", async () => {
    renderChat()
    await openPanel()
    expect(screen.getAllByTestId("peek-activity-pulse")).toHaveLength(1)
  })

  it("leaves the newest row unpulsed once the work is done", async () => {
    getWorkItem.mockImplementation((id: string) => Promise.resolve(detailOf(id, { status: "done" })))
    renderChat()
    await openPanel()
    expect(screen.queryByTestId("peek-activity-pulse")).toBeNull()
  })

  it("renders the property values read-only — no picker, no mutation", async () => {
    renderChat()
    await openPanel()

    const status = screen.getByTestId("peek-prop-status")
    expect(status.querySelector("button")).toBeNull()
    fireEvent.click(status)
    fireEvent.click(screen.getByTestId("peek-prop-assignee"))

    expect(screen.queryByRole("menu")).toBeNull()
    expect(getWorkItem).toHaveBeenCalledTimes(1)
  })
})

describe("peek panel query registration", () => {
  it("refetches when the gateway says that Todo changed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderChat()
    await openPanel()
    expect(getWorkItem).toHaveBeenCalledTimes(1)

    act(() => listener?.("company:changed", { entity: "todo", action: "status-transitioned", id: "ICI-1" }))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))

    await waitFor(() => expect(getWorkItem).toHaveBeenCalledTimes(2))
  })

  it("ignores a change to some other Todo", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderChat()
    await openPanel()

    act(() => listener?.("company:changed", { entity: "todo", action: "status-transitioned", id: "ICI-77" }))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))

    expect(getWorkItem).toHaveBeenCalledTimes(1)
  })
})

describe("peek panel navigation stack", () => {
  it("has no back control at depth 1", async () => {
    renderChat()
    await openPanel()
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull()
  })

  it("pushes a mention opened inside the panel and pops back to the first Todo", async () => {
    renderChat()
    await openPanel()

    // The Parent row's mention is the reference you follow from inside.
    fireEvent.click(await screen.findByRole("link", { name: "ICI-9" }))
    await screen.findByRole("heading", { name: "Title of ICI-9" })

    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    await screen.findByRole("heading", { name: "Title of ICI-1" })
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull()
  })
})

describe("peek panel dismissal", () => {
  it("closes on Escape and hands focus back to the mention that opened it", async () => {
    renderChat()
    const mention = screen.getByRole("link", { name: "ICI-1" })
    await openPanel()

    fireEvent.keyDown(document, { key: "Escape" })

    await waitFor(() => expect(screen.queryByTestId("peek-todo")).toBeNull())
    expect(document.activeElement).toBe(mention)
  })

  it("returns focus to the first opener even after following a reference", async () => {
    renderChat()
    const mention = screen.getByRole("link", { name: "ICI-1" })
    await openPanel()
    fireEvent.click(await screen.findByRole("link", { name: "ICI-9" }))
    await screen.findByRole("heading", { name: "Title of ICI-9" })

    fireEvent.click(screen.getByRole("button", { name: "Close preview" }))

    await waitFor(() => expect(screen.queryByTestId("peek-todo")).toBeNull())
    expect(document.activeElement).toBe(mention)
  })
})

describe("peek panel container", () => {
  it("mounts the rail alone on the desktop breakpoint", async () => {
    renderChat()
    await openPanel()

    expect(screen.getByTestId("peek-rail")).toBeTruthy()
    expect(screen.queryByTestId("peek-sheet")).toBeNull()
    expect(screen.queryByTestId("peek-scrim")).toBeNull()
    expect(screen.getAllByRole("button", { name: "Close preview" })).toHaveLength(1)
  })

  it("mounts the sheet and its scrim alone below 640px", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: true, media: "", addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    })
    renderChat()
    await openPanel()

    expect(screen.getByTestId("peek-sheet")).toBeTruthy()
    expect(screen.queryByTestId("peek-rail")).toBeNull()
    // The scrim carries the same accessible name, so the sheet has exactly the
    // one visible close control plus its tap-outside surface.
    expect(screen.getAllByRole("button", { name: "Close preview" })).toHaveLength(2)

    fireEvent.click(screen.getByTestId("peek-scrim"))
    await waitFor(() => expect(screen.queryByTestId("peek-todo")).toBeNull())
  })
})
