import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"
import { RunRow } from "../detail"
import type { CronRunWire } from "../shared"

const NOW = new Date("2026-08-01T04:00:00.000Z")

function renderRow(run: CronRunWire) {
  return render(
    <MemoryRouter>
      <RunRow run={run} now={NOW} />
    </MemoryRouter>,
  )
}

describe("RunRow", () => {
  it("links a run that spawned a session to that session's chat thread", () => {
    renderRow({ timestamp: "2026-08-01T03:00:00.000Z", status: "success", sessionId: "3f2b8c1e-9a44-4d7b-8b1a-5c0e7d216f90" })
    expect(screen.getByRole("link").getAttribute("href")).toBe("/?session=3f2b8c1e-9a44-4d7b-8b1a-5c0e7d216f90")
  })

  it("encodes the session id rather than interpolating it raw", () => {
    renderRow({ timestamp: "2026-08-01T03:00:00.000Z", status: "success", sessionId: "a b&c" })
    expect(screen.getByRole("link").getAttribute("href")).toBe("/?session=a%20b%26c")
  })

  it("renders a run with no session as an inert row with no hover fill", () => {
    const { container } = renderRow({ timestamp: "2026-08-01T03:00:00.000Z", status: "skipped" })
    expect(screen.queryByRole("link")).toBeNull()
    expect(screen.getByText("skipped")).toBeTruthy()
    expect(container.firstElementChild?.className).not.toContain("hover:bg-")
  })
})
