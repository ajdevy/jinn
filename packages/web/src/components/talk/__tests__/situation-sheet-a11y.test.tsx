import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SituationSheet } from "../situation-sheet"
import type { Situation } from "../situation-payload"
import { PAYLOADS } from "./situation-fixtures"

const SITUATION: Situation = {
  id: "s-1",
  title: "A decision",
  payload: PAYLOADS.options,
}

/** The page the sheet has to deactivate — and hand back untouched. */
function mountPage(): HTMLButtonElement {
  const page = document.createElement("div")
  page.id = "root"
  const pageButton = document.createElement("button")
  pageButton.textContent = "Behind the sheet"
  page.append(pageButton)
  document.body.append(page)
  return pageButton
}

function renderSheet(situation: Situation | null, onDismiss = vi.fn()) {
  const host = document.createElement("div")
  document.body.append(host)
  const result = render(
    <SituationSheet situation={situation} onAnswer={vi.fn()} onDismiss={onDismiss} />,
    { container: host },
  )
  return { ...result, onDismiss }
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
})

afterEach(() => {
  document.getElementById("root")?.remove()
})

describe("modality", () => {
  it("moves focus into the sheet on open", () => {
    mountPage()
    renderSheet(SITUATION)
    expect(document.activeElement).toBe(screen.getByRole("dialog"))
  })

  it("deactivates the page while open and restores it exactly on close", async () => {
    mountPage()
    const page = document.getElementById("root")!
    expect(page.inert).toBeFalsy()
    expect(page.getAttribute("aria-hidden")).toBeNull()

    const { rerender } = renderSheet(SITUATION)
    expect(page.inert).toBe(true)
    expect(page.getAttribute("aria-hidden")).toBe("true")

    rerender(<SituationSheet situation={null} onAnswer={vi.fn()} onDismiss={vi.fn()} />)
    await vi.waitFor(() => expect(page.getAttribute("aria-hidden")).toBeNull())
    expect(page.inert).toBeFalsy()
  })

  it("keeps Tab inside the sheet and off the dimmed page", async () => {
    const pageButton = mountPage()
    renderSheet(SITUATION)
    const cards = screen.getAllByRole("button").filter((b) => b.hasAttribute("data-situation-card"))

    for (let step = 0; step < cards.length + 2; step++) {
      await userEvent.tab()
      expect(document.activeElement).not.toBe(pageButton)
      expect(cards).toContain(document.activeElement)
    }
  })

  it("wraps backwards from the first card to the last", async () => {
    mountPage()
    renderSheet(SITUATION)
    const cards = screen.getAllByRole("button").filter((b) => b.hasAttribute("data-situation-card"))
    cards[0].focus()

    await userEvent.tab({ shift: true })

    expect(document.activeElement).toBe(cards[cards.length - 1])
  })

  it("closes on Escape and gives focus back to what had it", async () => {
    const pageButton = mountPage()
    pageButton.focus()
    const { onDismiss, rerender } = renderSheet(SITUATION)

    await userEvent.keyboard("{Escape}")
    expect(onDismiss).toHaveBeenCalled()

    rerender(<SituationSheet situation={null} onAnswer={vi.fn()} onDismiss={onDismiss} />)
    await vi.waitFor(() => expect(document.activeElement).toBe(pageButton), { timeout: 1000 })
  })
})
