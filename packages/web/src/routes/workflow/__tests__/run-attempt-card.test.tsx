import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { WorkflowAttemptV2Wire } from "@/lib/api"
import { AttemptCard } from "../run-attempt-card"

function attempt(resolvedConfig: WorkflowAttemptV2Wire["resolvedConfig"]): WorkflowAttemptV2Wire {
  return {
    runId: "run_1",
    nodeId: "writer",
    attempt: 1,
    status: "completed",
    resolvedConfig,
    startedAt: "2026-08-05T12:00:00.000Z",
    endedAt: "2026-08-05T12:00:30.000Z",
    remindersSent: 0,
    extensions: 0,
  }
}

describe("AttemptCard", () => {
  it("names the fallback engine and why the original could not serve the turn", () => {
    render(
      <AttemptCard
        attempt={attempt({
          employeeId: "blog-writer",
          engine: "codex",
          substitutedFrom: { engine: "claude", reason: "out of quota" },
        })}
      />,
    )
    expect(screen.getByText("Ran on codex — claude was out of quota")).toBeTruthy()
  })

  it("says nothing about substitution when the attempt ran on its own engine", () => {
    render(<AttemptCard attempt={attempt({ employeeId: "blog-writer", engine: "claude" })} />)
    expect(screen.queryByText(/Ran on/)).toBeNull()
  })
})
