import { act, fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { closePreview } from "../media-preview-store"
import { DISMISS_DISTANCE } from "../sheet-drag"
import { ORB_EDGE_GAP, ORB_SIZE } from "../situation-choreography"
import { PARK_STORAGE_KEY } from "../orb-park"
import { TalkSurface } from "../talk-surface"
import {
  dismissSituation,
  presentSituation,
  resolveSituation,
  restoreDeferredSituation,
} from "../talk-situation-store"
import { PAYLOADS } from "./situation-fixtures"

vi.mock("@/lib/api", () => ({ api: {} }))

const SITUATION = { id: "s-1", title: "A decision", payload: PAYLOADS.options }
const MEDIA_SITUATION = { id: "s-2", title: "Which cover?", payload: PAYLOADS.images }

/** A desktop sheet's box: jsdom lays nothing out, so the sheet is given one. */
const SHEET_BOX = { left: 312, top: 520, width: 816, height: 360, right: 1128, bottom: 880 }

const orb = () => document.querySelector<HTMLElement>("[data-talk-orb]")!
/** jsdom runs no cascade, so the Tailwind class is the only handle on the layer. */
const layerOf = (selector: string) =>
  Number(/z-\[(\d+)\]/.exec(document.querySelector<HTMLElement>(selector)!.className)?.[1])
const canvas = () => document.querySelector<HTMLCanvasElement>("[data-talk-orb] canvas")!
const offset = () => /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(orb().style.transform)
const overlay = () => document.querySelector<HTMLElement>("[data-talk-orb-overlay]")
const sheet = () => document.querySelector<HTMLElement>("[data-situation-sheet]")
const preview = () => document.querySelector<HTMLElement>("[data-media-preview]")
const scroller = () => document.querySelector<HTMLElement>("[data-situation-sheet] .overflow-y-auto")
const tile = (id: string) => document.querySelector<HTMLElement>(`[data-situation-tile="${id}"]`)!

const measure = Element.prototype.getBoundingClientRect

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
  vi.stubGlobal("innerWidth", 1440)
  vi.stubGlobal("innerHeight", 900)
  Element.prototype.getBoundingClientRect = function () {
    if (this instanceof HTMLElement && this.hasAttribute("data-situation-sheet")) {
      return { ...SHEET_BOX, x: SHEET_BOX.left, y: SHEET_BOX.top, toJSON: () => SHEET_BOX } as DOMRect
    }
    return measure.call(this)
  }
  const page = document.createElement("div")
  page.id = "root"
  document.body.append(page)
})

afterEach(() => {
  act(() => closePreview())
  act(() => resolveSituation())
  Element.prototype.getBoundingClientRect = measure
  document.getElementById("root")?.remove()
})

function mount() {
  return render(<TalkSurface />, { container: document.getElementById("root")! })
}

/** The entrance has to land before a gesture on the settled sheet means anything. */
async function raise(situation: typeof SITUATION) {
  mount()
  act(() => presentSituation(situation))
  await waitFor(() =>
    expect(document.querySelector("[data-situation-phase]")?.getAttribute("data-situation-phase")).toBe("open"),
  )
}

function escape() {
  fireEvent.keyDown(document, { key: "Escape" })
}

/** The three ways out of a preview, none of which may reach the sheet. */
const CLOSERS = {
  Escape: escape,
  "a scrim tap": () => fireEvent.click(document.querySelector("[data-media-preview] [role='dialog']")!),
  "a drag past the threshold": () => {
    const stage = document.querySelector("[data-preview-stage]")!
    const thrown = 200 + DISMISS_DISTANCE + 40
    fireEvent.pointerDown(stage, { pointerId: 3, clientY: 200 })
    fireEvent.pointerMove(stage, { pointerId: 3, clientY: thrown })
    fireEvent.pointerUp(stage, { pointerId: 3, clientY: thrown })
  },
}

/** `closing` still has a sheet in the DOM, so presence alone proves nothing. */
const sheetPhase = () =>
  document.querySelector("[data-situation-phase]")?.getAttribute("data-situation-phase")

describe("TalkSurface", () => {
  it("keeps the orb outside the page it deactivates, and interactive", () => {
    mount()
    act(() => presentSituation(SITUATION))

    const page = document.getElementById("root")!
    expect(page.inert).toBe(true)
    expect(page.contains(orb())).toBe(false)

    // Pointer events land on the sphere: a drag moves it under the finger.
    fireEvent.pointerDown(orb(), { pointerId: 1, button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(orb(), { pointerId: 1, clientX: 40, clientY: 30 })
    expect(orb().style.transform).toBe("translate3d(30px, 20px, 0)")
    fireEvent.pointerUp(orb(), { pointerId: 1, clientX: 40, clientY: 30 })
  })

  it("stacks the orb above the sheet, so hit testing cannot hand its taps to the scrim", () => {
    mount()
    act(() => presentSituation(SITUATION))

    expect(layerOf("[data-talk-orb-overlay]")).toBeGreaterThan(layerOf("[data-situation-phase]"))
  })

  it("flies the orb to the dock point and home again without remounting it", () => {
    mount()
    const sphere = canvas()
    expect(orb().style.transform).toBe("")

    act(() => presentSituation(SITUATION))

    expect(offset()).not.toBeNull()
    expect(orb().style.transitionDuration).toBe("280ms")
    expect(canvas()).toBe(sphere)

    act(() => dismissSituation())

    expect(orb().style.transform).toBe("translate3d(0px, 0px, 0)")
    expect(orb().style.transitionDuration).toBe("240ms")
    expect(canvas()).toBe(sphere)
  })

  it("docks just outside the sheet's right edge, at its vertical centre", () => {
    mount()
    act(() => presentSituation(SITUATION))

    // jsdom gives the parked sphere a zero box, so the offset IS the dock point.
    const shift = offset()!
    expect(Number(shift[1])).toBe(SHEET_BOX.right + ORB_EDGE_GAP + ORB_SIZE / 2)
    expect(Number(shift[2])).toBe(SHEET_BOX.top + SHEET_BOX.height / 2)
  })

  it("keeps the orb in the corner it was parked in", () => {
    localStorage.setItem(PARK_STORAGE_KEY, "top-left")
    mount()
    const parked = orb().className

    act(() => presentSituation(SITUATION))
    act(() => dismissSituation())

    expect(orb().className).toBe(parked)
    expect(localStorage.getItem(PARK_STORAGE_KEY)).toBe("top-left")
  })

  it("docks a left-parked orb to the same right edge, across the sheet", () => {
    localStorage.setItem(PARK_STORAGE_KEY, "top-left")
    mount()
    act(() => presentSituation(SITUATION))

    expect(Number(offset()![1])).toBe(SHEET_BOX.right + ORB_EDGE_GAP + ORB_SIZE / 2)
  })
})

describe("a preview over the sheet", () => {
  it("never drops the orb, and stacks between the sheet and it", async () => {
    await raise(MEDIA_SITUATION)
    const docked = overlay()

    fireEvent.click(tile("variant-a"))
    expect(preview()).not.toBeNull()
    expect(overlay()).toBe(docked)
    expect(layerOf("[data-situation-phase]")).toBeLessThan(layerOf("[data-media-preview]"))
    expect(layerOf("[data-media-preview]")).toBeLessThan(layerOf("[data-talk-orb-overlay]"))

    act(() => closePreview())

    expect(preview()).toBeNull()
    expect(overlay()).toBe(docked)
    expect(docked?.isConnected).toBe(true)
  })

  it("takes the preview down on Escape, then the sheet on a second one", async () => {
    await raise(MEDIA_SITUATION)
    fireEvent.click(tile("variant-a"))

    escape()
    expect(preview()).toBeNull()
    expect(sheetPhase()).toBe("open")

    escape()
    expect(sheetPhase()).toBe("closing")
    await waitFor(() => expect(sheet()).toBeNull())
  })

  it("closes only the preview on a scrim tap and on a drag past the threshold", async () => {
    await raise(MEDIA_SITUATION)

    fireEvent.click(tile("variant-a"))
    CLOSERS["a scrim tap"]()
    expect(preview()).toBeNull()
    expect(sheetPhase()).toBe("open")

    fireEvent.click(tile("variant-b"))
    CLOSERS["a drag past the threshold"]()

    expect(preview()).toBeNull()
    expect(sheetPhase()).toBe("open")
  })

  it("hands the sheet back the same one it left, whichever way the preview goes", async () => {
    await raise(MEDIA_SITUATION)
    const panel = sheet()
    const scrolled = scroller()

    for (const [how, close] of Object.entries(CLOSERS)) {
      fireEvent.click(tile("variant-b"))
      expect(preview(), how).not.toBeNull()

      close()

      // The same nodes, never rebuilt — so nothing they hold, scroll offset
      // and selection included, was thrown away and put back.
      expect(preview(), how).toBeNull()
      expect(sheet(), how).toBe(panel)
      expect(scroller(), how).toBe(scrolled)
      expect(panel?.getAttribute("data-situation-sheet"), how).toBe(MEDIA_SITUATION.id)
    }
  })
})

describe("dismissal", () => {
  it("defers rather than destroys: Escape puts the same situation back within reach", async () => {
    await raise(SITUATION)

    escape()
    await waitFor(() => expect(sheet()).toBeNull())

    act(() => restoreDeferredSituation())

    await waitFor(() => expect(sheet()?.getAttribute("data-situation-sheet")).toBe(SITUATION.id))
  })
})
