import { render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  listExperiments: vi.fn(),
  getExperiment: vi.fn(),
  getOrg: vi.fn(),
}))

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      ...actual.api,
      listExperiments: mocks.listExperiments,
      getExperiment: mocks.getExperiment,
      getOrg: mocks.getOrg,
    },
  }
})

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))


import ExperimentsPage from "../page"
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
  baseline: { activation: 21 },
  metrics: [{ name: "activation", unit: "%", howToMeasure: "Read the dashboard." }],
  readings: [],
}

const overdue = {
  ...running,
  id: "exp_333333333333",
  name: "Long-running bet",
  startedAt: "2026-01-01T09:00:00.000Z",
  horizonEndsAt: "2026-01-31T09:00:00.000Z",
  overdue: true,
  baseline: { activation: 21, referrals: 7 },
  metrics: [
    { name: "activation", unit: "%", howToMeasure: "Read the dashboard." },
    { name: "referrals", howToMeasure: "Count referral signups." },
  ],
}

const concluded = {
  id: "exp_222222222222",
  name: "Weekly prompt",
  hypothesis: "A clearer prompt will improve completion.",
  status: "concluded" as const,
  startedAt: "2026-07-01T09:00:00.000Z",
  horizonDays: 21,
  horizonEndsAt: "2026-07-22T09:00:00.000Z",
  overdue: false,
  baseline: { completion: 31, support: 5 },
  metrics: [
    { name: "completion", unit: "%", howToMeasure: "Read the completed-session report." },
    { name: "support", howToMeasure: "Count support requests." },
  ],
  readings: [
    { id: "rd_111111111111", experimentId: "exp_222222222222", at: "2026-07-08T09:00:00.000Z", metric: "completion", value: 34 },
    { id: "rd_222222222222", experimentId: "exp_222222222222", at: "2026-07-15T09:00:00.000Z", metric: "completion", value: 38 },
  ],
  verdict: {
    outcome: "win" as const,
    note: "Completion improved without more support requests.",
    concludedAt: "2026-07-22T09:00:00.000Z",
  },
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
}

beforeEach(() => {
  mocks.listExperiments.mockReset().mockResolvedValue({ experiments: [running, concluded] })
  mocks.getExperiment.mockReset().mockResolvedValue({ experiment: concluded })
  mocks.getOrg.mockReset().mockResolvedValue({ departments: [], employees: [], hierarchy: {} })
})

describe("Experiments list", () => {
  it("lists running and concluded experiments and shows a zero-reading state", async () => {
    render(
      <QueryClientProvider client={client()}>
        <MemoryRouter>
          <ExperimentsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(await screen.findByText("Onboarding clarity")).toBeTruthy()
    expect(screen.getByText("Weekly prompt")).toBeTruthy()
    expect(screen.getByTestId("experiment-readings-empty-exp_111111111111").textContent).toMatch(/no readings yet/i)
    expect(screen.getByText("Concluded")).toBeTruthy()
  })

  it("marks a running experiment past its horizon and leaves the others unmarked", async () => {
    mocks.listExperiments.mockResolvedValue({ experiments: [running, overdue, concluded] })
    render(
      <QueryClientProvider client={client()}>
        <MemoryRouter>
          <ExperimentsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(await screen.findByTestId("experiment-overdue-exp_333333333333")).toBeTruthy()
    expect(screen.queryByTestId("experiment-overdue-exp_111111111111")).toBeNull()
    expect(screen.queryByTestId("experiment-overdue-exp_222222222222")).toBeNull()
  })
})

describe("Experiment detail", () => {
  it("shows hypothesis, baseline against latest, charts, empty metrics, and the verdict", async () => {
    render(
      <QueryClientProvider client={client()}>
        <MemoryRouter initialEntries={["/experiments/exp_222222222222"]}>
          <Routes>
            <Route path="/experiments/:id" element={<ExperimentDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(await screen.findByText("A clearer prompt will improve completion.")).toBeTruthy()
    expect(screen.getByTestId("metric-baseline-completion").textContent).toContain("31%")
    expect(screen.getByTestId("metric-latest-completion").textContent).toContain("38%")
    expect(screen.getByRole("img", { name: "completion readings over time" })).toBeTruthy()
    expect(screen.getByTestId("metric-readings-empty-support").textContent).toMatch(/no readings yet/i)
    expect(screen.getByText("Completion improved without more support requests.")).toBeTruthy()
  })

  it("renders an experiment-wide empty state without a degenerate chart", async () => {
    mocks.getExperiment.mockResolvedValue({ experiment: running })
    render(
      <QueryClientProvider client={client()}>
        <MemoryRouter initialEntries={["/experiments/exp_111111111111"]}>
          <Routes>
            <Route path="/experiments/:id" element={<ExperimentDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(await screen.findByTestId("experiment-detail-readings-empty")).toBeTruthy()
    expect(screen.queryByRole("img", { name: /readings over time/i })).toBeNull()
  })

  it("renders the baseline of a later-added metric as a number and flags the overdue horizon", async () => {
    mocks.getExperiment.mockResolvedValue({ experiment: overdue })
    render(
      <QueryClientProvider client={client()}>
        <MemoryRouter initialEntries={["/experiments/exp_333333333333"]}>
          <Routes>
            <Route path="/experiments/:id" element={<ExperimentDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(await screen.findByTestId("experiment-overdue-exp_333333333333")).toBeTruthy()
    const baseline = screen.getByTestId("metric-baseline-referrals").textContent ?? ""
    expect(baseline).toContain("7")
    expect(baseline).not.toContain("—")
  })
})
