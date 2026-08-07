import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { closePreview } from "../media-preview-store"
import { DISMISS_DISTANCE } from "../sheet-drag"
import { SituationSheet } from "../situation-sheet"
import type { Situation, SituationPayload } from "../situation-payload"
import { PAYLOADS } from "./situation-fixtures"

vi.mock("@/lib/api", () => ({ api: {} }))

/** Three variants, because stepping is only interesting once it can wrap. */
const IMAGES: SituationPayload = {
  kind: "images",
  images: [
    { id: "variant-a", src: "a.png", alt: "Variant A", caption: "Variant A" },
    { id: "variant-b", src: "b.png", alt: "Variant B", caption: "Variant B" },
    { id: "variant-c", src: "c.png", alt: "Variant C", caption: "Variant C" },
  ],
}

const TILE_BOX = { left: 100, top: 200, width: 128, height: 128 }
const STAGE_BOX = { left: 400, top: 100, width: 640, height: 640 }
/** 128/640 wide, and the two centres 556px and 156px apart. */
const EXPECTED_FLIP = "translate(-556px, -156px) scale(0.2)"

const measure = Element.prototype.getBoundingClientRect

function boxFor(element: Element) {
  if (element.hasAttribute("data-situation-tile")) return TILE_BOX
  if (element.hasAttribute("data-preview-stage")) return STAGE_BOX
  return null
}

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
}

const preview = () => document.querySelector<HTMLElement>("[data-media-preview]")
const stage = () => document.querySelector<HTMLElement>("[data-preview-stage]")!
/** The scrim around the media, which is also the preview's own way out. */
const backdrop = () => document.querySelector<HTMLElement>('[data-media-preview] [role="dialog"]')!

function renderSheet(payload: SituationPayload, onAnswer = vi.fn()) {
  const situation: Situation = { id: "s-1", title: "Which cover?", payload }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <SituationSheet situation={situation} onAnswer={onAnswer} onDismiss={vi.fn()} />
    </QueryClientProvider>,
  )
  return { onAnswer }
}

beforeEach(() => {
  stubReducedMotion(false)
  Element.prototype.getBoundingClientRect = function () {
    const box = this instanceof HTMLElement ? boxFor(this) : null
    if (!box) return measure.call(this)
    return { ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => box } as DOMRect
  }
})

afterEach(() => {
  closePreview()
  Element.prototype.getBoundingClientRect = measure
})

describe("opening a preview from a tile", () => {
  it("opens the whole set at the tile that was tapped", async () => {
    renderSheet(IMAGES)
    expect(preview()).toBeNull()

    await userEvent.click(screen.getByRole("button", { name: /Variant B/ }))

    expect(preview()?.getAttribute("data-media-preview")).toBe("variant-b")
    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy()
  })

  it("opens on Enter and on Space from a focused tile", async () => {
    renderSheet(IMAGES)
    const tile = screen.getByRole("button", { name: /Variant C/ })

    tile.focus()
    await userEvent.keyboard("{Enter}")
    expect(preview()?.getAttribute("data-media-preview")).toBe("variant-c")

    closePreview()
    tile.focus()
    await userEvent.keyboard(" ")
    expect(preview()?.getAttribute("data-media-preview")).toBe("variant-c")
  })
})

describe("the shared-element entrance", () => {
  it("wears the thumbnail's box on its first frame, then lands untransformed", async () => {
    renderSheet(IMAGES)

    // Synchronous, so the assertion lands before the frame that releases it.
    fireEvent.click(screen.getByRole("button", { name: /Variant A/ }))
    expect(stage().style.transform).toBe(EXPECTED_FLIP)

    await waitFor(() => expect(stage().style.transform).toBe(""))
  })

  it("has no transform stage at all under reduced motion", async () => {
    stubReducedMotion(true)
    renderSheet(IMAGES)

    fireEvent.click(screen.getByRole("button", { name: /Variant A/ }))

    expect(stage().style.transform).toBe("")
    expect(stage().style.transitionDuration).toBe("0ms")
  })
})

describe("stepping across the set", () => {
  const shownId = () => preview()!.getAttribute("data-media-preview")

  it("cycles the whole set with both chevrons, wrapping, without coming down", async () => {
    renderSheet(IMAGES)
    await userEvent.click(screen.getByRole("button", { name: /Variant A/ }))
    const mounted = preview()

    await userEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(shownId()).toBe("variant-b")
    await userEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(shownId()).toBe("variant-c")
    await userEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(shownId()).toBe("variant-a")

    await userEvent.click(screen.getByRole("button", { name: "Previous" }))
    expect(shownId()).toBe("variant-c")

    expect(preview()).toBe(mounted)
    expect(mounted?.isConnected).toBe(true)
  })

  it("walks the same set with the arrow keys", async () => {
    renderSheet(IMAGES)
    await userEvent.click(screen.getByRole("button", { name: /Variant A/ }))
    const mounted = preview()

    await userEvent.keyboard("{ArrowRight}")
    expect(shownId()).toBe("variant-b")
    await userEvent.keyboard("{ArrowLeft}")
    await userEvent.keyboard("{ArrowLeft}")
    expect(shownId()).toBe("variant-c")

    expect(preview()).toBe(mounted)
  })
})

describe("gestures the preview must not read as a dismissal", () => {
  /** Far enough that a drag read from it would take the preview down. */
  const THROWN = DISMISS_DISTANCE + 100

  const image = () => document.querySelector<HTMLElement>('[data-preview-media="image"]')!
  const clip = () => document.querySelector<HTMLElement>('[data-preview-media="video"]')!

  /** Settled first: an entrance still wearing its FLIP hides any drag under it. */
  async function openedAt(name: RegExp) {
    await userEvent.click(screen.getByRole("button", { name }))
    await waitFor(() => expect(stage().style.transform).toBe(""))
  }

  it("keeps a pinch at fit out of the drag that closes the preview", async () => {
    renderSheet(IMAGES)
    await openedAt(/Variant A/)
    const pinched = image()

    fireEvent.pointerDown(pinched, { pointerId: 1, pointerType: "touch", clientX: 300, clientY: 300 })
    fireEvent.pointerDown(pinched, { pointerId: 2, pointerType: "touch", clientX: 500, clientY: 300 })
    fireEvent.pointerMove(pinched, { pointerId: 1, pointerType: "touch", clientX: 300, clientY: 300 + THROWN })
    fireEvent.pointerUp(pinched, { pointerId: 1, pointerType: "touch", clientX: 300, clientY: 300 + THROWN })

    expect(preview()).not.toBeNull()
    expect(stage().style.transform).toBe("")
    expect(Number(image().dataset.previewZoom)).toBeGreaterThan(1)
  })

  it("leaves a clip's own pointers with the clip, so scrubbing is not a dismissal", async () => {
    renderSheet(PAYLOADS.video)
    await openedAt(/Slow cut/)

    fireEvent.pointerDown(clip(), { pointerId: 5, clientY: 300 })
    fireEvent.pointerMove(clip(), { pointerId: 5, clientY: 300 + THROWN })
    fireEvent.pointerUp(clip(), { pointerId: 5, clientY: 300 + THROWN })

    expect(preview()).not.toBeNull()
    expect(stage().style.transform).toBe("")
  })

  /**
   * The one that bit in real Chrome: a clip's box is laid out from whichever of
   * the poster and the frames is painting, so it can move mid-gesture and leave
   * the finger over the scrim. The click that lands there began on the clip's
   * own controls, and a preview may not read that as a request to close.
   */
  it("never closes on a click whose gesture began on the clip's own controls", async () => {
    renderSheet(PAYLOADS.video)
    await openedAt(/Slow cut/)

    fireEvent.pointerDown(clip(), { pointerId: 9, clientY: 400 })
    fireEvent.click(backdrop())

    expect(preview()).not.toBeNull()
  })

  it("still closes on a click that both starts and ends on the scrim", async () => {
    renderSheet(PAYLOADS.video)
    await openedAt(/Slow cut/)

    fireEvent.pointerDown(backdrop(), { pointerId: 9, clientY: 400 })
    fireEvent.click(backdrop())

    expect(preview()).toBeNull()
  })
})

describe("what the preview shows", () => {
  it("toggles an image between fit and 2x from the zoom control", async () => {
    renderSheet(IMAGES)
    await userEvent.click(screen.getByRole("button", { name: /Variant A/ }))
    const image = () => document.querySelector<HTMLElement>('[data-preview-media="image"]')!

    expect(image().dataset.previewZoom).toBe("1")
    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    expect(image().dataset.previewZoom).toBe("2")
    await userEvent.click(screen.getByRole("button", { name: "Reset zoom" }))
    expect(image().dataset.previewZoom).toBe("1")
  })

  it("gives a clip real controls, with its sound left on", async () => {
    renderSheet(PAYLOADS.video)
    await userEvent.click(screen.getByRole("button", { name: /Fast cut/ }))

    const clip = document.querySelector<HTMLVideoElement>('[data-preview-media="video"]')!
    expect(clip.hasAttribute("controls")).toBe(true)
    expect(clip.hasAttribute("playsinline")).toBe(true)
    expect(clip.muted).toBe(false)
    expect(clip.getAttribute("src")).toBe("fast.mp4")
  })

  it("offers no zoom control on a clip: a player has nothing to zoom into", async () => {
    renderSheet(PAYLOADS.video)
    await userEvent.click(screen.getByRole("button", { name: /Slow cut/ }))

    expect(screen.queryByRole("button", { name: /zoom/i })).toBeNull()
  })
})
