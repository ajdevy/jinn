import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { RouterProvider, createMemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

const listWorkflowDefinitions = vi.fn()
const getWorkflowDefinition = vi.fn()
const createWorkflow = vi.fn()
const setWorkflowEnabled = vi.fn()
const setWorkflowRetired = vi.fn()
const duplicateWorkflow = vi.fn()

vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    constructor(readonly status: number, message: string, readonly code?: string) {
      super(message)
    }
  }
  class WorkflowValidationApiError extends ApiError {
    constructor(status: number, message: string, code: string | undefined, readonly issues: unknown[]) {
      super(status, message, code)
    }
  }
  return {
    ApiError,
    WorkflowValidationApiError,
    api: {
      listWorkflowDefinitionsV2: (...args: unknown[]) => listWorkflowDefinitions(...args),
      getWorkflowDefinitionV2: (...args: unknown[]) => getWorkflowDefinition(...args),
      createWorkflowV2: (...args: unknown[]) => createWorkflow(...args),
      setWorkflowEnabledV2: (...args: unknown[]) => setWorkflowEnabled(...args),
      setWorkflowRetiredV2: (...args: unknown[]) => setWorkflowRetired(...args),
      duplicateWorkflowV2: (...args: unknown[]) => duplicateWorkflow(...args),
    },
  }
})
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@/context/breadcrumb-context", () => ({ useBreadcrumbs: () => undefined }))

import { ApiError } from "@/lib/api"
import WorkflowListPage from "../list"

const summary = {
  id: "morning-digest",
  title: "Morning Digest",
  description: null,
  revision: 3,
  enabled: true,
  retiredAt: null,
  createdAt: "2026-07-23T08:00:00.000Z",
  updatedAt: "2026-07-23T08:00:00.000Z",
}
const archivedSummary = { ...summary, enabled: false, retiredAt: "2026-08-01T09:00:00.000Z" }
const definition = { ...summary, schemaVersion: 1, nodes: [], edges: [] }

function renderList(path = "/workflow") {
  const router = createMemoryRouter([
    { path: "/workflow", element: <WorkflowListPage /> },
    { path: "/workflow/:id", element: <p>editor</p> },
  ], { initialEntries: [path] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

/** The row is a link, so every menu assertion has to prove the click stayed put. */
async function openRowMenu() {
  await userEvent.click(await screen.findByLabelText("Workflow actions for Morning Digest"))
}

beforeEach(() => {
  vi.clearAllMocks()
  listWorkflowDefinitions.mockImplementation((_cursor: string | undefined, retired: boolean) =>
    Promise.resolve({ items: retired ? [archivedSummary] : [summary], nextCursor: null }))
  getWorkflowDefinition.mockResolvedValue(definition)
  setWorkflowRetired.mockResolvedValue({ ...definition, enabled: false, revision: 4 })
  setWorkflowEnabled.mockResolvedValue({ ...definition, enabled: false, revision: 4 })
  duplicateWorkflow.mockResolvedValue({ ...definition, id: "copy-of-morning-digest", revision: 1, enabled: false })
})

describe("workflow list lifecycle menu", () => {
  it("opens the menu without following the row's link", async () => {
    const router = renderList()

    await openRowMenu()

    const menu = await screen.findByRole("menu")
    expect(within(menu).getByRole("menuitem", { name: "Disable" })).toBeTruthy()
    expect(within(menu).getByRole("menuitem", { name: "Duplicate…" })).toBeTruthy()
    expect(within(menu).getByRole("menuitem", { name: "Archive workflow" })).toBeTruthy()
    expect(router.state.location.pathname).toBe("/workflow")
  })

  it("confirms before archiving and does nothing when the confirmation is dismissed", async () => {
    renderList()
    await openRowMenu()

    await userEvent.click(await screen.findByRole("menuitem", { name: "Archive workflow" }))
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }))

    expect(setWorkflowRetired).not.toHaveBeenCalled()
  })

  it("archives with the revision the row is holding", async () => {
    renderList()
    await openRowMenu()

    await userEvent.click(await screen.findByRole("menuitem", { name: "Archive workflow" }))
    await userEvent.click(await screen.findByRole("button", { name: "Archive" }))

    await waitFor(() => expect(setWorkflowRetired).toHaveBeenCalledWith("morning-digest", true, 3))
  })

  it("offers unarchive on the archived shelf, and no enable there", async () => {
    renderList("/workflow?retired=true")

    await openRowMenu()

    const menu = await screen.findByRole("menu")
    expect(within(menu).getByRole("menuitem", { name: "Unarchive workflow" })).toBeTruthy()
    expect(within(menu).queryByRole("menuitem", { name: "Enable" })).toBeNull()

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Unarchive workflow" }))

    await waitFor(() => expect(setWorkflowRetired).toHaveBeenCalledWith("morning-digest", false, 3))
  })

  it("keeps the archived shelf in the URL so a reload lands back on it", async () => {
    const router = renderList()

    await userEvent.click(await screen.findByRole("button", { name: "Archived" }))

    expect(router.state.location.search).toBe("?retired=true")
    await waitFor(() => expect(listWorkflowDefinitions).toHaveBeenCalledWith(undefined, true))
  })

  it("duplicates from a name prefilled with the source title", async () => {
    renderList()
    await openRowMenu()

    await userEvent.click(await screen.findByRole("menuitem", { name: "Duplicate…" }))
    const name = await screen.findByLabelText("Workflow title")
    expect((name as HTMLInputElement).value).toBe("Copy of Morning Digest")
    await userEvent.click(screen.getByRole("button", { name: "Duplicate" }))

    await waitFor(() => expect(duplicateWorkflow).toHaveBeenCalledWith("morning-digest",
      { id: "copy-of-morning-digest", title: "Copy of Morning Digest" }))
  })

  it("shows an ID collision inside the duplicate dialog instead of failing silently", async () => {
    duplicateWorkflow.mockRejectedValue(new ApiError(409, "Workflow definition copy-of-morning-digest already exists.", "id-conflict"))
    renderList()
    await openRowMenu()

    await userEvent.click(await screen.findByRole("menuitem", { name: "Duplicate…" }))
    await userEvent.click(await screen.findByRole("button", { name: "Duplicate" }))

    expect((await screen.findByRole("alert")).textContent).toContain("already exists")
  })

  it("says so and refetches when a lifecycle write is rejected as stale", async () => {
    setWorkflowEnabled.mockRejectedValue(new ApiError(409, "Workflow definition morning-digest revision does not match.", "revision-conflict"))
    renderList()
    await openRowMenu()

    await userEvent.click(await screen.findByRole("menuitem", { name: "Disable" }))

    expect((await screen.findByRole("status")).textContent).toContain("changed elsewhere")
    await waitFor(() => expect(listWorkflowDefinitions.mock.calls.length).toBeGreaterThan(1))
  })
})
