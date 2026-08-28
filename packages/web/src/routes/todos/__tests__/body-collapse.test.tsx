import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BodyEditor } from "../task-page/body-editor"
import { BODY_CLAMP_PX } from "../task-page/body-editor-constants"

const LONG_BODY = "## Scope\n\n" + Array.from({ length: 40 }, (_, i) => `- item ${i}`).join("\n")
const SHORT_BODY = "## Scope\n\nOne line."

/* jsdom lays nothing out, so scrollHeight is always 0 and the component would
 * never see an overflowing body. Drive the one measurement it reads instead. */
let renderedHeight = 0
Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
  configurable: true,
  get: () => renderedHeight,
})

function measureAt(height: number) {
  renderedHeight = height
}

afterEach(() => {
  renderedHeight = 0
  vi.restoreAllMocks()
})

function renderBody(body: string) {
  return render(<BodyEditor body={body} editable isDark onCommit={vi.fn()} />)
}

describe("the Todo body collapse", () => {
  it("clamps an overflowing body and offers to reveal the rest", () => {
    measureAt(BODY_CLAMP_PX + 200)
    renderBody(LONG_BODY)

    expect(screen.getByTestId("task-body-read").style.maxHeight).toBe(`${BODY_CLAMP_PX}px`)
    expect(screen.getByTestId("task-body-scrim")).toBeTruthy()
    expect(screen.getByTestId("task-body-toggle").textContent).toContain("Show more")
  })

  it("releases the clamp and the scrim on Show more, and takes them back on Show less", () => {
    measureAt(BODY_CLAMP_PX + 200)
    renderBody(LONG_BODY)

    fireEvent.click(screen.getByTestId("task-body-toggle"))

    const read = screen.getByTestId("task-body-read")
    // Expanded rests at the measured content height, which is what the
    // max-height transition animates to — a bound, not a clamp.
    expect(read.style.maxHeight).not.toBe(`${BODY_CLAMP_PX}px`)
    expect(Number.parseInt(read.style.maxHeight, 10)).toBeGreaterThanOrEqual(BODY_CLAMP_PX + 200)
    expect(read.style.transition || read.className).toContain("max-height")
    expect(screen.queryByTestId("task-body-scrim")).toBeNull()
    expect(screen.getByTestId("task-body-toggle").textContent).toContain("Show less")

    fireEvent.click(screen.getByTestId("task-body-toggle"))

    expect(screen.getByTestId("task-body-read").style.maxHeight).toBe(`${BODY_CLAMP_PX}px`)
    expect(screen.getByTestId("task-body-scrim")).toBeTruthy()
  })

  it("expands from the fade itself without opening the editor", () => {
    measureAt(BODY_CLAMP_PX + 200)
    renderBody(LONG_BODY)

    fireEvent.click(screen.getByTestId("task-body-scrim"))

    // The fade lives inside the click-to-edit region, so it has to swallow its
    // own click: reaching the editor here would mean the reader tapped to reveal
    // and got a cursor instead.
    const read = screen.getByTestId("task-body-read")
    expect(read.style.maxHeight).not.toBe(`${BODY_CLAMP_PX}px`)
    expect(screen.queryByTestId("task-body-scrim")).toBeNull()
    expect(screen.getByTestId("task-body-toggle").textContent).toContain("Show less")
    expect(screen.queryByTestId("task-body-loading")).toBeNull()
    expect(document.querySelector("[contenteditable=true]")).toBeNull()
  })

  it("leaves a body that fits exactly as it renders today", () => {
    measureAt(BODY_CLAMP_PX)
    const { container } = renderBody(SHORT_BODY)

    const read = screen.getByTestId("task-body-read")
    expect(container.children.length).toBe(1)
    expect(container.firstElementChild).toBe(read)
    expect(read.getAttribute("style")).toBeNull()
    expect(read.className).toBe("w-full cursor-text text-left outline-none")
    expect(screen.queryByTestId("task-body-scrim")).toBeNull()
    expect(screen.queryByTestId("task-body-toggle")).toBeNull()
  })

  it("starts collapsed on every mount and persists nothing", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem")
    measureAt(BODY_CLAMP_PX + 200)

    const first = renderBody(LONG_BODY)
    fireEvent.click(screen.getByTestId("task-body-toggle"))
    expect(screen.getByTestId("task-body-toggle").textContent).toContain("Show less")
    first.unmount()

    renderBody(LONG_BODY)
    expect(screen.getByTestId("task-body-read").style.maxHeight).toBe(`${BODY_CLAMP_PX}px`)
    expect(screen.getByTestId("task-body-toggle").textContent).toContain("Show more")
    expect(setItem).not.toHaveBeenCalled()
  })

  it("opens the editor unclamped from a collapsed body", async () => {
    measureAt(BODY_CLAMP_PX + 200)
    const { container } = renderBody(LONG_BODY)

    fireEvent.click(screen.getByTestId("task-body-read"))

    const prose = await waitFor(
      () => {
        const element = document.querySelector<HTMLElement>(".ProseMirror[contenteditable=true]")
        if (!element) throw new Error("editor has not loaded")
        return element
      },
      { timeout: 4000 },
    )

    for (let node = prose.parentElement; node && node !== container; node = node.parentElement) {
      expect(node.style.maxHeight).toBe("")
    }
    expect(screen.queryByTestId("task-body-scrim")).toBeNull()
    expect(screen.queryByTestId("task-body-toggle")).toBeNull()
  }, 10000)

  it("still opens the editor when the body text itself is clicked", async () => {
    measureAt(BODY_CLAMP_PX + 200)
    renderBody(LONG_BODY)

    fireEvent.click(screen.getByTestId("task-body-read").querySelector("h2")!)

    await waitFor(() => expect(document.querySelector(".ProseMirror[contenteditable=true]")).toBeTruthy(), {
      timeout: 4000,
    })
  }, 10000)
})
