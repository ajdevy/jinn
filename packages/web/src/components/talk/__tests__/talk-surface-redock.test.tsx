import { act, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ORB_EDGE_GAP, ORB_SIZE } from "../situation-choreography"
import { TalkSurface } from "../talk-surface"
import { presentSituation } from "../talk-situation-store"
import { PAYLOADS, clearSituations } from "./situation-fixtures"

/**
 * The orb docks to the sheet's box, and both of them move when the window does.
 *
 * A sheet raised on a desktop and then carried to a phone width is the case that
 * put the sphere in the middle of its own controls: the sheet was measured once,
 * so the orb kept flying to a box that no longer existed, and the next flight was
 * plotted from a rect that already had the old one in it.
 */

vi.mock("@/lib/api", () => ({ api: {} }))

const SITUATION = { id: "s-1", title: "A decision", payload: PAYLOADS.options }

const DESKTOP = { viewport: { width: 1440, height: 900 }, sheet: { left: 312, top: 520, width: 816, height: 360 } }
const PHONE = { viewport: { width: 390, height: 844 }, sheet: { left: 0, top: 490, width: 390, height: 354 } }

/** Where the corner classes would put the sphere. jsdom runs no cascade, so all
 *  that matters is that it moves with the viewport, the way a corner does. */
const parkedAt = (viewport: { width: number; height: number }) => ({
  left: viewport.width - 96,
  top: viewport.height - 140,
})

const orb = () => document.querySelector<HTMLElement>("[data-talk-orb]")!

const shift = () => {
  const applied = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(orb().style.transform)
  return { x: Number(applied?.[1] ?? 0), y: Number(applied?.[2] ?? 0) }
}

const measure = Element.prototype.getBoundingClientRect
let stage = DESKTOP

function rect(left: number, top: number, width: number, height: number): DOMRect {
  const box = { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }
  return { ...box, toJSON: () => box } as DOMRect
}

/** The sphere's layout box, plus a rect that carries its transform the way a real
 *  one does — which is what makes measuring the rect the wrong way to find park. */
function layOutSphere(): void {
  const sphere = orb()
  const park = () => parkedAt({ width: window.innerWidth, height: window.innerHeight })
  const box = {
    offsetLeft: () => park().left,
    offsetTop: () => park().top,
    offsetWidth: () => ORB_SIZE,
    offsetHeight: () => ORB_SIZE,
  }
  for (const [name, read] of Object.entries(box)) {
    Object.defineProperty(sphere, name, { get: read, configurable: true })
  }
  sphere.getBoundingClientRect = () =>
    rect(park().left + shift().x, park().top + shift().y, ORB_SIZE, ORB_SIZE)
}

/** Where the sphere's centre actually ends up: its corner plus what it carries. */
function sphereCentre(): { x: number; y: number } {
  const park = parkedAt({ width: window.innerWidth, height: window.innerHeight })
  return { x: park.left + ORB_SIZE / 2 + shift().x, y: park.top + ORB_SIZE / 2 + shift().y }
}

function show(next: typeof DESKTOP): void {
  stage = next
  vi.stubGlobal("innerWidth", next.viewport.width)
  vi.stubGlobal("innerHeight", next.viewport.height)
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
  show(DESKTOP)
  Element.prototype.getBoundingClientRect = function () {
    if (this instanceof HTMLElement && this.hasAttribute("data-situation-sheet")) {
      return rect(stage.sheet.left, stage.sheet.top, stage.sheet.width, stage.sheet.height)
    }
    return measure.call(this)
  }
  const page = document.createElement("div")
  page.id = "root"
  document.body.append(page)
})

afterEach(() => {
  act(() => clearSituations())
  Element.prototype.getBoundingClientRect = measure
  document.getElementById("root")?.remove()
})

describe("the docked orb across a viewport change", () => {
  it("flies to the sheet's new edge instead of to the box it was raised in", async () => {
    render(<TalkSurface />, { container: document.getElementById("root")! })
    layOutSphere()

    act(() => presentSituation(SITUATION))
    await waitFor(() =>
      expect(document.querySelector("[data-situation-phase]")?.getAttribute("data-situation-phase")).toBe("open"),
    )

    // On a desktop the dock is the shoulder beside the sheet, at its centre.
    expect(sphereCentre()).toEqual({
      x: DESKTOP.sheet.left + DESKTOP.sheet.width + ORB_EDGE_GAP + ORB_SIZE / 2,
      y: DESKTOP.sheet.top + DESKTOP.sheet.height / 2,
    })

    show(PHONE)
    act(() => {
      window.dispatchEvent(new Event("resize"))
    })

    // On a phone there is no room beside a full-width sheet, so it straddles the
    // top edge inside the gutter the header keeps clear — never the body, which
    // is where the fields are.
    expect(sphereCentre()).toEqual({
      x: PHONE.sheet.left + PHONE.sheet.width - ORB_EDGE_GAP - ORB_SIZE / 2,
      y: PHONE.sheet.top,
    })
  })
})
