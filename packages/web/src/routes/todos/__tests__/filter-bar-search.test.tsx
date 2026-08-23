import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SearchOverlayProvider, useSearchOverlay } from "@/components/search-overlay-context"
import { FilterBar } from "../filter-bar"

const listLabels = vi.fn()
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: { ...actual.api, listLabels: (...args: unknown[]) => listLabels(...args) },
  }
})

/** What the filter row last asked the global overlay to open, read from the DOM. */
function OverlayProbe() {
  const { request } = useSearchOverlay()
  return <div data-testid="overlay-request">{request ? `${request.scope ?? ""}|${request.query ?? ""}` : ""}</div>
}

function openedSearch(): { scope: string; query: string } | null {
  const text = screen.getByTestId("overlay-request").textContent ?? ""
  if (!text) return null
  const [scope, query] = text.split("|")
  return { scope, query }
}

const originalMatchMedia = window.matchMedia
function setDesktop() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

afterEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia })
})

/** The board row plus somewhere else to type, so `/` has both cases to answer. */
function renderBoard(filters: Parameters<typeof FilterBar>[0]["filters"] = { status: "open" }, onChange = vi.fn()) {
  setDesktop()
  listLabels.mockResolvedValue({ labels: [] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  rtlRender(
    <QueryClientProvider client={client}>
      <SearchOverlayProvider>
        <FilterBar filters={filters} onChange={onChange} employees={[]} departments={[]} byName={new Map()} hideStatus board />
        <input aria-label="Somewhere else to type" />
        <OverlayProbe />
      </SearchOverlayProvider>
    </QueryClientProvider>,
  )
  return onChange
}

describe("the Todos search box as the overlay's entry point", () => {
  it("opens the global overlay scoped to Todos rather than searching the board itself", () => {
    renderBoard()

    fireEvent.click(screen.getByTestId("filter-search"))

    expect(openedSearch()).toEqual({ scope: "todo", query: "" })
  })

  it("hands the overlay the first keystroke rather than dropping it", () => {
    renderBoard()

    fireEvent.keyDown(screen.getByTestId("filter-search"), { key: "r" })

    expect(openedSearch()).toEqual({ scope: "todo", query: "r" })
  })

  it("leaves Enter and Space as the box's own activation keys", () => {
    renderBoard()

    fireEvent.keyDown(screen.getByTestId("filter-search"), { key: " " })
    fireEvent.keyDown(screen.getByTestId("filter-search"), { key: "Enter" })

    expect(openedSearch()).toBeNull()
  })

  it("opens the overlay on a bare /", () => {
    renderBoard()

    const slash = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true })
    act(() => { document.body.dispatchEvent(slash) })

    expect(slash.defaultPrevented).toBe(true)
    expect(openedSearch()).toEqual({ scope: "todo", query: "" })
  })

  it("lets / through as a slash while a text field has focus", () => {
    renderBoard()

    const slash = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true })
    act(() => { screen.getByLabelText("Somewhere else to type").dispatchEvent(slash) })

    expect(slash.defaultPrevented).toBe(false)
    expect(openedSearch()).toBeNull()
  })

  it("shows a deep-linked ?q= as one removable chip, since the box no longer holds it", () => {
    const onChange = renderBoard({ status: "open", q: "roadmap" })

    fireEvent.click(screen.getByRole("button", { name: 'Remove Matching "roadmap"' }))

    expect(onChange).toHaveBeenCalledWith({ status: "open", q: undefined })
  })
})
