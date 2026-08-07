import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { GatewayEvent, GatewayEventListener } from "@jinn/gateway-events"
import { TodoPrefixContext } from "@/components/chat/todo-prefix-context"
import { TodoMention } from "@/components/todo-mention"
import { useQueryInvalidation } from "@/hooks/use-query-invalidation"
import { PeekPanel } from "../peek-panel"
import { PeekProvider } from "../peek-stack"
import { BODY, detailOf } from "./peek-fixtures"

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

/** `intoAppRoot` mounts under the #root the sheet inerts, which is the only way
 *  the inert-versus-focus ordering is observable from a test. */
function renderChat({ intoAppRoot = false } = {}) {
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
  let container: HTMLElement | undefined
  if (intoAppRoot) {
    container = document.createElement("div")
    container.id = "root"
    document.body.appendChild(container)
  }
  return render(
    <MemoryRouter initialEntries={["/chat"]}>
      <QueryClientProvider client={client}>
        <TodoPrefixContext.Provider value={new Set(["ICI"])}>
          <Harness />
        </TodoPrefixContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
    container ? { container } : undefined,
  )
}

function atSheetBreakpoint() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: true, media: "", addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  })
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
  document.getElementById("root")?.remove()
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
    atSheetBreakpoint()
    renderChat()
    await openPanel()

    expect(screen.getByTestId("peek-sheet")).toBeTruthy()
    expect(screen.queryByTestId("peek-rail")).toBeNull()
    // The scrim is an unnamed tap-outside surface, so the sheet exposes exactly
    // one control called "Close preview" — the same count the rail exposes.
    expect(screen.getAllByRole("button", { name: "Close preview" })).toHaveLength(1)

    fireEvent.click(screen.getByTestId("peek-scrim"))
    await waitFor(() => expect(screen.queryByTestId("peek-todo")).toBeNull())
  })
})

describe("peek sheet focus restoration", () => {
  /** jsdom does not enforce inert, so asserting activeElement here would pass
   *  either way. What is observable — and what the browser actually punishes —
   *  is the ordering: the opener must not be focused while #root is still inert. */
  async function inertAtFocusTime(dismiss: () => void): Promise<boolean> {
    atSheetBreakpoint()
    renderChat({ intoAppRoot: true })
    const mention = screen.getByRole("link", { name: "ICI-1" })
    await openPanel()

    let inertWhenFocused: boolean | undefined
    const realFocus = mention.focus.bind(mention)
    mention.focus = (options?: FocusOptions) => {
      inertWhenFocused = Boolean(document.getElementById("root")?.inert)
      realFocus(options)
    }

    dismiss()
    await waitFor(() => expect(screen.queryByTestId("peek-todo")).toBeNull())
    expect(inertWhenFocused, "the opener was never focused at all").toBeDefined()
    expect(document.activeElement).toBe(mention)
    return inertWhenFocused as boolean
  }

  it("lifts the inert app root before Escape hands focus back", async () => {
    expect(await inertAtFocusTime(() => fireEvent.keyDown(document, { key: "Escape" }))).toBe(false)
  })

  it("lifts the inert app root before a scrim tap hands focus back", async () => {
    expect(await inertAtFocusTime(() => fireEvent.click(screen.getByTestId("peek-scrim")))).toBe(false)
  })
})
