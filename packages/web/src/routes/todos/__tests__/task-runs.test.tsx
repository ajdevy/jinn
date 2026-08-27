import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { WorkItemRunWire } from "@/lib/api"
import { RunsSection } from "../task-page/runs"

/* ICI-728 — the run ledger's read surface: one row per attempt with its
 * outcome and the handoff a reviewer reads, an OPEN attempt that reads as
 * in-flight instead of borrowing an outcome it never reported, and no section
 * at all for a Todo nobody has attempted yet (ICI-1435). */

const SETTLED_LABELS = ["Completed", "Blocked", "Crashed", "Timed out", "Abandoned"]

function run(id: string, overrides: Partial<WorkItemRunWire> = {}): WorkItemRunWire {
  return {
    id,
    workItemId: "PLA-12",
    sessionId: `session-${id}`,
    startedAt: "2026-07-22T08:00:00.000Z",
    endedAt: "2026-07-22T08:40:00.000Z",
    outcome: "completed",
    summary: null,
    handoff: {},
    error: null,
    ...overrides,
  }
}

describe("run ledger section", () => {
  it("renders one row per attempt with its outcome and the handoff it reported", () => {
    render(
      <RunsSection
        runs={[
          run("wir_000000000001", {
            outcome: "crashed",
            summary: "Fell over installing the toolchain",
            error: "The session running this attempt is gone.",
            handoff: { retryNotes: "Pin the toolchain before installing." },
          }),
          run("wir_000000000002", {
            summary: "Guest checkout shipped",
            handoff: {
              changedFiles: ["src/checkout/session.ts", "src/checkout/session.test.ts"],
              verification: "Unit suite green",
              residualRisk: "The refund path is still untested.",
            },
          }),
        ]}
      />,
    )

    const rows = [...screen.getByTestId("task-runs").querySelectorAll('[data-testid^="run-row-"]')]
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "run-row-wir_000000000001",
      "run-row-wir_000000000002",
    ])

    const crashed = screen.getByTestId("run-row-wir_000000000001")
    expect(crashed.textContent).toContain("Crashed")
    expect(crashed.textContent).toContain("Fell over installing the toolchain")
    expect(screen.getByTestId("run-handoff-wir_000000000001").textContent)
      .toContain("Pin the toolchain before installing.")
    expect(screen.getByTestId("run-handoff-wir_000000000001").textContent)
      .toContain("The session running this attempt is gone.")

    const completed = screen.getByTestId("run-row-wir_000000000002")
    expect(completed.textContent).toContain("Completed")
    const handoff = screen.getByTestId("run-handoff-wir_000000000002")
    expect(handoff.textContent).toContain("src/checkout/session.ts")
    expect(handoff.textContent).toContain("src/checkout/session.test.ts")
    expect(handoff.textContent).toContain("Unit suite green")
    expect(handoff.textContent).toContain("The refund path is still untested.")
    // Nothing was reported for retry notes, so the row stays silent about it.
    expect(handoff.textContent).not.toContain("Retry notes")
  })

  it("reads an open attempt as in-flight and never gives it a settled outcome", () => {
    render(<RunsSection runs={[run("wir_00000000open", { endedAt: null, outcome: null })]} />)

    const row = screen.getByTestId("run-row-wir_00000000open")
    expect(row.textContent).toContain("Running")
    for (const label of SETTLED_LABELS) expect(row.textContent).not.toContain(label)
    // Nothing was handed off yet either — an open attempt has reported nothing.
    expect(screen.queryByTestId("run-handoff-wir_00000000open")).toBeNull()
  })

  it("renders nothing at all when a Todo has never been attempted", () => {
    render(<RunsSection runs={[]} />)

    expect(screen.queryByTestId("task-runs")).toBeNull()
  })
})
