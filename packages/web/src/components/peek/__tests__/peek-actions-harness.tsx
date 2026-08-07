import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { vi } from "vitest"
import type { WorkItemStatusWire } from "@/lib/api"
import { TodoPrefixContext } from "@/components/chat/todo-prefix-context"
import { TodoMention } from "@/components/todo-mention"
import { PeekPanel } from "../peek-panel"
import { PeekProvider } from "../peek-stack"
import { detailOf } from "./peek-fixtures"

/* How the peek's quick actions are mounted and driven. What they are supposed to
 * do lives next door in todo-peek-actions.test.tsx; this is only the harness. */

const realMatchMedia = window.matchMedia

/** A chat with one Todo mention in it and the panel that opens off it. */
export function renderChat(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
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
  return client
}

export function atSheetBreakpoint() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: true, media: "", addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  })
}

export function restoreBreakpoint() {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: realMatchMedia })
}

export async function openPanel() {
  fireEvent.click(screen.getByRole("link", { name: "ICI-1" }))
  await screen.findByTestId("peek-todo")
}

/** Open a property's picker and wait for its rows to be there to click. */
export async function openPicker(property: "status" | "assignee") {
  fireEvent.click(screen.getByTestId(`peek-row-${property}`))
  await screen.findByTestId(
    property === "status" ? "status-option-done" : "assignee-option-unassign",
  )
}

export function statusRowText(): string {
  return screen.getByTestId("peek-prop-status").textContent ?? ""
}

export function assigneeRowText(): string {
  return screen.getByTestId("peek-prop-assignee").textContent ?? ""
}

/** The tree behind the close gate: `openKids` children still in flight. */
export function treeOf(openKids: number) {
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
