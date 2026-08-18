import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TalkSurface } from "../talk-surface"
import { presentSituation } from "../talk-situation-store"
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
  it("renders only Aurora even when legacy card and undo stores contain work", () => {
    render(<TalkSurface />, { container: document.getElementById("root")! })

    act(() => {
      presentSituation({
        id: "legacy-decision",
        title: "Do not attach this text",
        payload: { kind: "prose", text: "This must stay off the live Talk surface." },
      })
      offerUndo("Do not attach an undo strip", async () => {})
    })

    expect(document.querySelectorAll("[data-talk-orb]")).toHaveLength(1)
    expect(document.querySelector("[data-situation-sheet]")).toBeNull()
    expect(document.querySelector("[data-talk-undo-strip]")).toBeNull()
    expect(document.querySelector("[data-media-preview]")).toBeNull()
    expect(document.body.textContent).toBe("")
  })
})
