import { fireEvent, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { PARK_STORAGE_KEY } from "../orb-park"
import { TalkOrb } from "../talk-orb"

function mountOrb() {
  const { container, unmount } = render(<TalkOrb />)
  const overlay = container.querySelector<HTMLElement>("[data-talk-orb-overlay]")!
  const sphere = container.querySelector<HTMLElement>("[data-talk-orb]")!
  return { container, overlay, sphere, unmount }
}

/** jsdom's viewport. Half of it is where `nearestCorner` flips. */
const VIEWPORT = { width: 1024, height: 768 }

function drag(sphere: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }) {
  fireEvent.pointerDown(sphere, { pointerId: 1, button: 0, clientX: from.x, clientY: from.y })
  fireEvent.pointerMove(sphere, { pointerId: 1, clientX: to.x, clientY: to.y })
  fireEvent.pointerUp(sphere, { pointerId: 1, clientX: to.x, clientY: to.y })
}

let originalGetContext: HTMLCanvasElement["getContext"]

beforeEach(() => {
  localStorage.clear()
  window.innerWidth = VIEWPORT.width
  window.innerHeight = VIEWPORT.height
  // jsdom logs a "not implemented" warning per canvas otherwise. These tests are
  // about the widget around the canvas; `orb-canvas.test.tsx` covers the paint.
  originalGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = (() => null) as never
})

afterEach(() => {
  localStorage.clear()
  HTMLCanvasElement.prototype.getContext = originalGetContext
})

describe("TalkOrb never blocks the page", () => {
  it("takes no pointer events outside the sphere", () => {
    const { overlay, sphere } = mountOrb()

    expect(overlay.className).toContain("pointer-events-none")
    expect(sphere.className).toContain("pointer-events-auto")
  })

  it("re-enables pointer events on the sphere alone, clipped to its circle", () => {
    const { overlay, sphere } = mountOrb()

    const reenabling = overlay.querySelectorAll(".pointer-events-auto")
    expect(reenabling).toHaveLength(1)
    expect(reenabling[0]).toBe(sphere)
    // A square canvas inside a round element would still take events in the
    // corners; `overflow-hidden` clips hit-testing to the circle.
    expect(sphere.className).toContain("rounded-full")
    expect(sphere.className).toContain("overflow-hidden")
  })
})

describe("TalkOrb carries no text", () => {
  it("renders no visible text node", () => {
    const { overlay } = mountOrb()

    expect(overlay.textContent).toBe("")
  })

  it("carries no title or tooltip on any node", () => {
    const { overlay } = mountOrb()

    expect(overlay.querySelector("[title]")).toBeNull()
    expect(overlay.hasAttribute("title")).toBe(false)
  })

  it("names itself for screen readers only", () => {
    const { sphere } = mountOrb()

    expect(sphere.getAttribute("aria-label")).toBe("Talk")
    expect(sphere.querySelector("canvas")?.getAttribute("aria-hidden")).toBe("true")
  })
})

describe("TalkOrb dragging", () => {
  it("moves by transform while the pointer is down", () => {
    const { sphere } = mountOrb()

    fireEvent.pointerDown(sphere, { pointerId: 1, button: 0, clientX: 100, clientY: 100 })
    expect(sphere.style.transform).toBe("translate3d(0px, 0px, 0)")

    fireEvent.pointerMove(sphere, { pointerId: 1, clientX: 340, clientY: 260 })
    expect(sphere.style.transform).toBe("translate3d(240px, 160px, 0)")
  })

  it("snaps to the nearest corner on release and persists it", () => {
    const { sphere } = mountOrb()

    drag(sphere, { x: 100, y: 100 }, { x: 900, y: 700 })

    expect(localStorage.getItem(PARK_STORAGE_KEY)).toBe("bottom-right")
    expect(sphere.className).toContain("bottom-")
    expect(sphere.className).toContain("right-")
    // The transform is handed back to the corner class, not left stacked on it.
    expect(sphere.style.transform).toBe("")
  })

  it("persists whichever corner the release lands nearest", () => {
    const { sphere } = mountOrb()

    drag(sphere, { x: 900, y: 700 }, { x: 100, y: 50 })
    expect(localStorage.getItem(PARK_STORAGE_KEY)).toBe("top-left")

    drag(sphere, { x: 100, y: 50 }, { x: 900, y: 60 })
    expect(localStorage.getItem(PARK_STORAGE_KEY)).toBe("top-right")

    drag(sphere, { x: 900, y: 60 }, { x: 60, y: 700 })
    expect(localStorage.getItem(PARK_STORAGE_KEY)).toBe("bottom-left")
  })

  it("drops the drag without moving the orb when the pointer is cancelled", () => {
    const { sphere } = mountOrb()

    fireEvent.pointerDown(sphere, { pointerId: 1, button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(sphere, { pointerId: 1, clientX: 900, clientY: 700 })
    fireEvent.pointerCancel(sphere, { pointerId: 1 })

    expect(sphere.style.transform).toBe("")
    expect(localStorage.getItem(PARK_STORAGE_KEY)).toBeNull()
  })

  it("ignores a non-primary mouse button", () => {
    const { sphere } = mountOrb()

    fireEvent.pointerDown(sphere, { pointerId: 1, button: 2, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(sphere, { pointerId: 1, clientX: 900, clientY: 700 })

    expect(sphere.style.transform).toBe("")
  })
})

describe("TalkOrb park position", () => {
  it("restores the stored corner on mount, so a remount cannot lose it", () => {
    localStorage.setItem(PARK_STORAGE_KEY, "top-left")

    const { sphere } = mountOrb()

    expect(sphere.className).toContain("top-[calc(var(--safe-top)+16px)]")
    expect(sphere.className).toContain("left-[calc(var(--safe-left)+16px)]")
  })

  it("defaults to the bottom-right corner, clear of the mobile tab bar", () => {
    const { sphere } = mountOrb()

    expect(sphere.className).toContain("bottom-[calc(49px+max(var(--safe-bottom),6px)+22px)]")
    expect(sphere.className).toContain("lg:bottom-5")
  })
})
