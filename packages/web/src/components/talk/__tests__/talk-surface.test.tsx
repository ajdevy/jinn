import { act, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ORB_EDGE_GAP, ORB_SIZE } from "../situation-choreography"
import { PARK_STORAGE_KEY } from "../orb-park"
import { TalkSurface } from "../talk-surface"
import { dismissSituation, presentSituation } from "../talk-situation-store"
import { PAYLOADS } from "./situation-fixtures"

vi.mock("@/lib/api", () => ({ api: {} }))

const SITUATION = { id: "s-1", title: "A decision", payload: PAYLOADS.options }

/** A desktop sheet's box: jsdom lays nothing out, so the sheet is given one. */
const SHEET_BOX = { left: 312, top: 520, width: 816, height: 360, right: 1128, bottom: 880 }

const orb = () => document.querySelector<HTMLElement>("[data-talk-orb]")!
const canvas = () => document.querySelector<HTMLCanvasElement>("[data-talk-orb] canvas")!
const offset = () => /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(orb().style.transform)

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
  act(() => dismissSituation())
  Element.prototype.getBoundingClientRect = measure
  document.getElementById("root")?.remove()
})

function mount() {
  return render(<TalkSurface />, { container: document.getElementById("root")! })
}

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

  it("mirrors the dock to the sheet's left edge for a left-parked orb", () => {
    localStorage.setItem(PARK_STORAGE_KEY, "top-left")
    mount()
    act(() => presentSituation(SITUATION))

    expect(Number(offset()![1])).toBe(SHEET_BOX.left - ORB_EDGE_GAP - ORB_SIZE / 2)
  })
})
