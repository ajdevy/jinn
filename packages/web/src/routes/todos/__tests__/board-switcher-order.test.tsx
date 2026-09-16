import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import type { DepartmentSummaryWire } from "@/lib/api"
import { BoardSwitcher } from "../board/board-switcher"

/* ICI-1357, criterion 6. The operator's complaint was structural: `Everything`
 * sat below every department, so at fourteen departments it was a scroll away.
 * These pin the ORDER — three lenses, then the places — at both org sizes,
 * because the defect only shows once the department list is long. */

const listWorkItems = vi.fn(async (_params?: Record<string, unknown>) => ({ workItems: [], totals: {} }))
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: { listWorkItems: (...args: unknown[]) => listWorkItems(...(args as [])) } }
})

function departments(count: number): DepartmentSummaryWire[] {
  return Array.from({ length: count }, (_, i) => ({
    slug: `dept-${i + 1}`,
    prefix: `D${String(i + 1).padStart(2, "0")}`,
  })) as DepartmentSummaryWire[]
}

async function openMenu(count: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/todos/b/home"]}>
        <BoardSwitcher board={{ kind: "home" }} title="Home" departments={departments(count)} attentionCount={3} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const trigger = await screen.findByTestId("board-switcher")
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" })
  fireEvent.click(trigger)
  await waitFor(() => expect(screen.getByTestId("board-menu-home")).toBeTruthy())
}

/** Every menu row and group label, in the order the DOM actually holds them. */
function rowOrder(): string[] {
  const menu = screen.getByTestId("board-menu-home").closest("[role='menu']") ?? document.body
  return Array.from(menu.querySelectorAll("[data-testid^='board-menu-'], [data-slot='dropdown-menu-label']")).map(
    (el) => el.getAttribute("data-testid") ?? `label:${el.textContent?.trim()}`,
  )
}

describe.each([5, 14, 22])("the switcher at %i departments", (count) => {
  it("leads with Home, Attention and Everything, above the departments group", async () => {
    await openMenu(count)
    const order = rowOrder()

    expect(order.slice(0, 3)).toEqual(["board-menu-home", "board-menu-attention", "board-menu-everything"])
    expect(order[3]).toBe("label:Departments")
    expect(order.slice(4)).toEqual(departments(count).map((d) => `board-menu-${d.slug}`))
  })

  it("puts every department after Everything, never before it", async () => {
    await openMenu(count)
    const order = rowOrder()
    const everything = order.indexOf("board-menu-everything")
    for (const dept of departments(count)) {
      expect(order.indexOf(`board-menu-${dept.slug}`)).toBeGreaterThan(everything)
    }
  })
})

describe("the switcher with no departments", () => {
  it("renders the three lenses and no empty group label", async () => {
    await openMenu(0)
    expect(rowOrder()).toEqual(["board-menu-home", "board-menu-attention", "board-menu-everything"])
  })
})

/* PLA-230, criterion 7. The Home row counts the very set the Home board draws,
 * so it asks for the same union scope — a pinned-only count here would label
 * Home with a number the board itself disagrees with. */
describe("the switcher's Home count", () => {
  it("counts the union scope rather than the pinned one", async () => {
    listWorkItems.mockClear()
    await openMenu(2)

    const scopes = listWorkItems.mock.calls.map(([params]) => params)
    expect(scopes).toContainEqual({ home: true, rootsOnly: true, limit: 1 })
    for (const params of scopes) expect(params?.kept).toBeUndefined()
  })
})
