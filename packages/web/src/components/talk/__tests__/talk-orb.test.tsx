import { fireEvent, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PARK_STORAGE_KEY } from "../orb-park"
import { TalkOrb } from "../talk-orb"

function mountOrb(props: Partial<Parameters<typeof TalkOrb>[0]> = {}) {
  const { container, unmount } = render(<TalkOrb {...props} />)
  const overlay = container.querySelector<HTMLElement>("[data-talk-orb-overlay]")!
  const sphere = container.querySelector<HTMLElement>("[data-talk-orb]")!
  return { container, overlay, sphere, unmount }
}

/** jsdom's viewport. Half of it is where `nearestCorner` flips. */
const VIEWPORT = { width: 1024, height: 768 }

/** A pointer sequence, ending in the click the browser fires after every one. */
function drag(sphere: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }) {
  fireEvent.pointerDown(sphere, { pointerId: 1, button: 0, clientX: from.x, clientY: from.y })
  fireEvent.pointerMove(sphere, { pointerId: 1, clientX: to.x, clientY: to.y })
  fireEvent.pointerUp(sphere, { pointerId: 1, clientX: to.x, clientY: to.y })
  fireEvent.click(sphere)
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

    expect(sphere.getAttribute("aria-label")).toBe("Start voice session")
    expect(sphere.querySelector("canvas")?.getAttribute("aria-hidden")).toBe("true")
  })
})

describe("TalkOrb paint strategy", () => {
  it("exposes the selected geometry without changing the live hit target", () => {
    const { sphere } = mountOrb({ variant: "ring" })

    expect(sphere.getAttribute("data-orb-variant")).toBe("ring")
    expect(sphere.style.width).toBe("64px")
    expect(sphere.style.height).toBe("64px")
  })
})

describe("TalkOrb as the voice control", () => {
  it("is a real button, so it is reachable and operable by keyboard", () => {
    const { sphere } = mountOrb()

    expect(sphere.tagName).toBe("BUTTON")
    expect(sphere.getAttribute("type")).toBe("button")
    // No tabindex of its own: a button is already in the tab order, and pinning
    // one is how an element quietly leaves it.
    expect(sphere.hasAttribute("tabindex")).toBe(false)
  })

  it("says whether a session is open, in words and in state", () => {
    expect(mountOrb().sphere.getAttribute("aria-pressed")).toBe("false")

    const live = render(<TalkOrb active onToggle={() => {}} />)
    const sphere = live.container.querySelector<HTMLElement>("[data-talk-orb]")!
    expect(sphere.getAttribute("aria-pressed")).toBe("true")
    expect(sphere.getAttribute("aria-label")).toBe("End voice session")
  })

  it("starts a session when it is pressed", () => {
    const toggle = vi.fn()
    const { sphere } = mountOrb({ onToggle: toggle })

    fireEvent.click(sphere)

    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it("does NOT start one when it was dragged — moving the orb is not asking to talk", () => {
    const toggle = vi.fn()
    const { sphere } = mountOrb({ onToggle: toggle })

    drag(sphere, { x: 100, y: 100 }, { x: 900, y: 700 })

    expect(toggle).not.toHaveBeenCalled()
  })

  it("still counts a press that wobbled a pixel as a press", () => {
    const toggle = vi.fn()
    const { sphere } = mountOrb({ onToggle: toggle })

    drag(sphere, { x: 100, y: 100 }, { x: 102, y: 101 })

    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it("does not swallow the press after the drag it swallowed", () => {
    const toggle = vi.fn()
    const { sphere } = mountOrb({ onToggle: toggle })

    drag(sphere, { x: 100, y: 100 }, { x: 900, y: 700 })
    fireEvent.click(sphere)

    expect(toggle).toHaveBeenCalledTimes(1)
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
