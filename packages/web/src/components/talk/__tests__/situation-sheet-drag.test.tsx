import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DISMISS_DISTANCE, rubberBand } from "../sheet-drag"
import { SituationSheet } from "../situation-sheet"
import type { Situation } from "../situation-payload"
import { PAYLOADS } from "./situation-fixtures"

vi.mock("@/lib/api", () => ({ api: {} }))

const SITUATION: Situation = { id: "s-1", title: "A decision", payload: PAYLOADS.options }

const PAST_THRESHOLD = DISMISS_DISTANCE + 100
const UNDER_THRESHOLD = 40

/** Queries are scoped to one render: a test may raise more than one sheet. */
async function renderSheet() {
  const onDismiss = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { container } = render(
    <QueryClientProvider client={client}>
      <SituationSheet situation={SITUATION} onAnswer={vi.fn()} onDismiss={onDismiss} />
    </QueryClientProvider>,
  )
  const find = (selector: string) => container.querySelector<HTMLElement>(selector)!
  // Settled first: mid-entrance the sheet is wearing its own scale and there is
  // nothing to drag yet.
  await waitFor(() =>
    expect(find("[data-situation-phase]").dataset.situationPhase).toBe("open"),
  )
  return {
    onDismiss,
    grabber: () => find("[data-situation-grabber]"),
    header: () => find("[data-situation-sheet] header"),
    panel: () => find("[data-situation-sheet]"),
  }
}

/**
 * One instant for the whole gesture, so no sample clears the hook's one-frame
 * floor and velocity stays at rest. Which is the point: these are the distance
 * cases, and the flick lives in `sheet-drag.test.ts`. The clock is pinned rather
 * than left to jsdom, which usually fires a gesture inside a single millisecond
 * but under a loaded suite can take longer than the floor between two events and
 * turn a 40px drag into a flick nobody performed.
 */
function drag(
  origin: HTMLElement,
  distance: number,
  pointerType: "mouse" | "touch" | "pen" = "mouse",
) {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0)
  fireEvent.pointerDown(origin, { pointerId: 7, pointerType, clientY: 300 })
  fireEvent.pointerMove(origin, { pointerId: 7, pointerType, clientY: 300 + distance })
  fireEvent.pointerUp(origin, { pointerId: 7, pointerType, clientY: 300 + distance })
  clock.mockRestore()
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
})

describe("the drag handle", () => {
  it("renders the grabber at every breakpoint", async () => {
    const sheet = await renderSheet()
    expect(sheet.grabber().className).not.toContain("lg:hidden")
  })

  it("takes the gesture from the grabber and from the header alike", async () => {
    const fromGrabber = await renderSheet()
    drag(fromGrabber.grabber(), PAST_THRESHOLD)
    expect(fromGrabber.onDismiss).toHaveBeenCalledTimes(1)

    const fromHeader = await renderSheet()
    drag(fromHeader.header(), PAST_THRESHOLD)
    expect(fromHeader.onDismiss).toHaveBeenCalledTimes(1)
  })
})

describe("dragging the sheet", () => {
  it("follows the finger 1:1 within the threshold, and rubber-bands past it", async () => {
    const { grabber, panel } = await renderSheet()

    fireEvent.pointerDown(grabber(), { pointerId: 7, clientY: 300 })
    fireEvent.pointerMove(grabber(), { pointerId: 7, clientY: 300 + UNDER_THRESHOLD })
    expect(panel().style.transform).toBe(`translateY(${UNDER_THRESHOLD}px)`)

    fireEvent.pointerMove(grabber(), { pointerId: 7, clientY: 300 + PAST_THRESHOLD })
    expect(panel().style.transform).toBe(`translateY(${rubberBand(PAST_THRESHOLD)}px)`)
    expect(rubberBand(PAST_THRESHOLD)).toBeLessThan(PAST_THRESHOLD)
  })

  it("snaps back a short, slow drag and leaves the sheet where it was", async () => {
    const { onDismiss, grabber, panel } = await renderSheet()

    drag(grabber(), UNDER_THRESHOLD)

    expect(onDismiss).not.toHaveBeenCalled()
    expect(panel().style.transform).toBe("")
  })

  it("dismisses once the drag is past the distance threshold", async () => {
    const { onDismiss, grabber } = await renderSheet()

    drag(grabber(), PAST_THRESHOLD)

    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it("snaps back a flick the finger sat on before letting go", async () => {
    const { onDismiss, grabber } = await renderSheet()
    // The one thing jsdom cannot produce on its own: elapsed time between the
    // sample and the release, which is the whole of what this decides on.
    const clock = vi.spyOn(performance, "now")

    clock.mockReturnValue(0)
    fireEvent.pointerDown(grabber(), { pointerId: 7, clientY: 300 })
    clock.mockReturnValue(60)
    fireEvent.pointerMove(grabber(), { pointerId: 7, clientY: 300 + UNDER_THRESHOLD + 20 })
    clock.mockReturnValue(560)
    fireEvent.pointerUp(grabber(), { pointerId: 7, clientY: 300 + UNDER_THRESHOLD + 20 })
    clock.mockRestore()

    expect(onDismiss).not.toHaveBeenCalled()
  })

  it("damps an upward drag and never dismisses on one", async () => {
    const { onDismiss, grabber, panel } = await renderSheet()

    fireEvent.pointerDown(grabber(), { pointerId: 7, clientY: 300 })
    fireEvent.pointerMove(grabber(), { pointerId: 7, clientY: 100 })
    expect(panel().style.transform).toBe(`translateY(${rubberBand(-200)}px)`)
    fireEvent.pointerUp(grabber(), { pointerId: 7, clientY: 100 })

    expect(onDismiss).not.toHaveBeenCalled()
  })

  it("gives a finger, a mouse and a pen the same outcome from the same movement", async () => {
    for (const pointerType of ["mouse", "touch", "pen"] as const) {
      const dismissing = await renderSheet()
      drag(dismissing.grabber(), PAST_THRESHOLD, pointerType)
      expect(dismissing.onDismiss, `${pointerType} past the threshold`).toHaveBeenCalledTimes(1)

      const holding = await renderSheet()
      drag(holding.grabber(), UNDER_THRESHOLD, pointerType)
      expect(holding.onDismiss, `${pointerType} under the threshold`).not.toHaveBeenCalled()
    }
  })
})
