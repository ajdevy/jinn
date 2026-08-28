import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getExperiment: vi.fn(),
  getOrg: vi.fn(),
  recordExperimentReading: vi.fn(),
  concludeExperiment: vi.fn(),
}))

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getExperiment: mocks.getExperiment,
      getOrg: mocks.getOrg,
      recordExperimentReading: mocks.recordExperimentReading,
      concludeExperiment: mocks.concludeExperiment,
    },
  }
})

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))


import ExperimentDetailPage from "../detail"

const running = {
  id: "exp_111111111111",
  name: "Onboarding clarity",
  hypothesis: "A smaller first step will improve activation.",
  status: "running" as const,
  startedAt: "2026-08-01T09:00:00.000Z",
  horizonDays: 30,
  horizonEndsAt: "2026-08-31T09:00:00.000Z",
  overdue: false,
  baseline: { activation: 21, referrals: 7 },
  metrics: [
    { name: "activation", unit: "%", howToMeasure: "Read the dashboard." },
    { name: "referrals", howToMeasure: "Count referral signups." },
  ],
  readings: [
    { id: "rd_111111111111", experimentId: "exp_111111111111", at: "2026-08-05T09:00:00.000Z", metric: "activation", value: 23 },
  ],
}

const linked = { ...running, todoId: "ABC-12", owner: "a-lead" }

const concluded = {
  ...running,
  status: "concluded" as const,
  verdict: { outcome: "win" as const, note: "Activation improved.", concludedAt: "2026-08-20T09:00:00.000Z" },
}

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/experiments/exp_111111111111"]}>
        <Routes>
          <Route path="/experiments/:id" element={<ExperimentDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mocks.getExperiment.mockReset().mockResolvedValue({ experiment: running })
  mocks.getOrg.mockReset().mockResolvedValue({
    departments: [],
    employees: [{ name: "a-lead", displayName: "A Lead", department: "growth", rank: "senior", engine: "codex", model: "m", persona: "" }],
    hierarchy: {},
  })
  mocks.recordExperimentReading.mockReset().mockResolvedValue({ reading: {} })
  mocks.concludeExperiment.mockReset().mockResolvedValue({ experiment: concluded })
})

describe("Experiment detail actions", () => {
  it("records a reading against a declared metric and shows the new point without a reload", async () => {
    const user = userEvent.setup()
    renderDetail()

    await user.click(await screen.findByTestId("experiment-record-reading-open"))
    const dialog = screen.getByTestId("experiment-record-reading")
    expect(within(dialog).getAllByRole("radio").map((option) => option.textContent)).toEqual([
      "activation (%)",
      "referrals",
    ])

    await user.click(within(dialog).getByRole("radio", { name: "referrals" }))
    await user.type(screen.getByTestId("experiment-reading-value"), "9")
    mocks.getExperiment.mockResolvedValue({
      experiment: {
        ...running,
        readings: [
          ...running.readings,
          { id: "rd_222222222222", experimentId: running.id, at: "2026-08-09T09:00:00.000Z", metric: "referrals", value: 9 },
        ],
      },
    })
    await user.click(screen.getByTestId("experiment-record-reading-submit"))

    await waitFor(() => expect(mocks.recordExperimentReading).toHaveBeenCalledWith(
      "exp_111111111111",
      expect.objectContaining({ metric: "referrals", value: 9 }),
    ))
    await waitFor(() => expect(screen.queryByTestId("experiment-record-reading")).toBeNull())
    await waitFor(() => expect(screen.getByTestId("metric-latest-referrals").textContent).toContain("9"))
  })

  it("concludes with an outcome and a note, then hides both actions", async () => {
    const user = userEvent.setup()
    renderDetail()

    await user.click(await screen.findByTestId("experiment-conclude-open"))
    const dialog = screen.getByTestId("experiment-conclude")
    await user.click(within(dialog).getByRole("radio", { name: "Loss" }))
    await user.type(screen.getByTestId("experiment-conclude-note"), "Referrals never moved.")
    mocks.getExperiment.mockResolvedValue({ experiment: concluded })
    await user.click(screen.getByTestId("experiment-conclude-submit"))

    await waitFor(() => expect(mocks.concludeExperiment).toHaveBeenCalledWith(
      "exp_111111111111",
      { outcome: "loss", note: "Referrals never moved." },
    ))
    expect(await screen.findByText("Activation improved.")).toBeTruthy()
    expect(screen.queryByTestId("experiment-record-reading-open")).toBeNull()
    expect(screen.queryByTestId("experiment-conclude-open")).toBeNull()
  })

  it("never offers either action on a concluded experiment", async () => {
    mocks.getExperiment.mockResolvedValue({ experiment: concluded })
    renderDetail()

    expect(await screen.findByText("Activation improved.")).toBeTruthy()
    expect(screen.queryByTestId("experiment-record-reading-open")).toBeNull()
    expect(screen.queryByTestId("experiment-conclude-open")).toBeNull()
  })

  it("keeps a rejected submission open and shows the gateway's own words", async () => {
    const user = userEvent.setup()
    const { ApiError } = await import("@/lib/api")
    mocks.recordExperimentReading.mockRejectedValue(new ApiError(409, "readings cannot be added after an experiment is concluded"))
    renderDetail()

    await user.click(await screen.findByTestId("experiment-record-reading-open"))
    await user.type(screen.getByTestId("experiment-reading-value"), "24")
    await user.click(screen.getByTestId("experiment-record-reading-submit"))

    expect((await screen.findByTestId("experiment-record-reading-error")).textContent)
      .toBe("readings cannot be added after an experiment is concluded")
    expect(screen.getByTestId("experiment-record-reading")).toBeTruthy()
  })
})

describe("Experiment detail links", () => {
  it("renders the Todo as a link and the owner as a chip", async () => {
    mocks.getExperiment.mockResolvedValue({ experiment: linked })
    renderDetail()

    const link = await screen.findByTestId("experiment-todo-link")
    expect(link.getAttribute("href")).toBe("/todos/ABC-12")
    expect(link.textContent).toContain("ABC-12")
    expect(await screen.findByText("A Lead")).toBeTruthy()
  })

  it("renders neither when the experiment has no Todo and no owner", async () => {
    renderDetail()

    expect(await screen.findByRole("heading", { name: "Onboarding clarity" })).toBeTruthy()
    expect(screen.queryByTestId("experiment-todo-link")).toBeNull()
  })
})
