import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TalkSurface } from "../talk-surface"
import { askSituation } from "../talk-situation-store"
import { offerUndo } from "../talk-undo-store"
import { clearSituations } from "./situation-fixtures"

vi.mock("@/lib/api", () => ({ api: {} }))

beforeEach(() => {
  const page = document.createElement("div")
  page.id = "root"
  document.body.append(page)
})

afterEach(() => {
  act(() => clearSituations())
  document.getElementById("root")?.remove()
})

describe("the live Talk surface", () => {
  it("renders only Aurora at rest even when the legacy undo store contains work", () => {
    render(<TalkSurface />, { container: document.getElementById("root")! })

    act(() => {
      offerUndo("Do not attach an undo strip", async () => {})
    })

    expect(document.querySelectorAll("[data-talk-orb]")).toHaveLength(1)
    expect(document.querySelector("[data-situation-sheet]")).toBeNull()
    expect(document.querySelector("[data-talk-undo-strip]")).toBeNull()
    expect(document.querySelector("[data-media-preview]")).toBeNull()
    expect(document.body.textContent).toBe("")
  })

  it("shows an awaited consent sheet and settles a refusal", async () => {
    render(<TalkSurface />, { container: document.getElementById("root")! })

    let consent!: Promise<string | null>
    act(() => {
      consent = askSituation({
        id: "consent-named-send",
        title: "Send this to the session?",
        hint: "Ship it.",
        payload: {
          kind: "options",
          options: [
            { id: "go", label: "Send it" },
            { id: "leave", label: "Leave it" },
          ],
        },
      })
    })

    expect(await screen.findByRole("dialog", { name: "Send this to the session?" })).not.toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Leave it" }))

    await expect(consent).resolves.toBe("leave")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })
})
