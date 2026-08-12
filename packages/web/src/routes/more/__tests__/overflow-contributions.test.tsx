import type { ReactNode } from "react"
import { act, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import { contributions } from "@/contrib/registry"
import { AREAS } from "@/contrib/types"
import MorePage from "../page"

// The phone's ONLY route to a non-primary destination is this screen, so the
// `sidebar.nav` host is only really hosted once a contributed row lands here.
// Everything the page needs beyond navigation stands in as a stub, the same
// substitution the settings suite makes.
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("@/context/breadcrumb-context", () => ({ useBreadcrumbs: vi.fn() }))
vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark", setTheme: vi.fn() }) }))
vi.mock("@/hooks/use-features", () => ({ useFeatures: () => ({ data: undefined, isPending: false }) }))
vi.mock("@/hooks/use-workspaces", () => ({
  useWorkspaces: () => ({ data: [] }),
  useStartWorkspace: () => ({ isPending: false, variables: undefined, mutateAsync: vi.fn() }),
}))
vi.mock("@/components/workspaces/create-workspace-dialog", () => ({ CreateWorkspaceDialog: () => null }))

const disposers: (() => void)[] = []

afterEach(() => {
  act(() => {
    for (const dispose of disposers.splice(0)) dispose()
  })
})

function renderMore() {
  return render(
    <MemoryRouter initialEntries={["/more"]}>
      <MorePage />
    </MemoryRouter>,
  )
}

function contribute(id: string, data: unknown): void {
  act(() => {
    disposers.push(contributions.register({ id, area: AREAS.sidebarNav, data }, `plugin:${id}`))
  })
}

describe("the More overflow screen", () => {
  it("adds a row contributed after the screen mounted", () => {
    renderMore()
    expect(screen.queryByRole("link", { name: "Inbox Demo" })).toBeNull()

    contribute("inbox-demo:nav", { href: "/inbox-demo", label: "Inbox Demo" })

    expect(screen.getByRole("link", { name: "Inbox Demo" }).getAttribute("href")).toBe("/inbox-demo")
  })

  it("drops the row again when the plugin unloads", () => {
    contribute("inbox-demo:nav", { href: "/inbox-demo", label: "Inbox Demo" })
    renderMore()
    expect(screen.getByRole("link", { name: "Inbox Demo" })).toBeTruthy()

    act(() => {
      for (const dispose of disposers.splice(0)) dispose()
    })

    expect(screen.queryByRole("link", { name: "Inbox Demo" })).toBeNull()
  })

  it("keeps Settings out of the overflow card and in the App group", () => {
    renderMore()

    const settings = screen.getByRole("link", { name: "Settings" })
    expect(settings.getAttribute("href")).toBe("/settings")
    expect(screen.getAllByRole("link", { name: "Settings" })).toHaveLength(1)
  })
})
