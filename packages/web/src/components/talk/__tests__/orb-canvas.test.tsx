import { render, cleanup } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OrbCanvas } from "../orb-canvas"

/** jsdom has no 2D context, so the canvas API is a spy the paints are counted on. */
function fakeContext() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    clip: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    globalCompositeOperation: "source-over",
    globalAlpha: 1,
    fillStyle: "",
  }
}

let ctx: ReturnType<typeof fakeContext>
let originalGetContext: HTMLCanvasElement["getContext"]

/** Every paint starts with one `clearRect`. */
const paints = () => ctx.clearRect.mock.calls.length

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
}

const levelRef = { current: 0 }

beforeEach(() => {
  ctx = fakeContext()
  originalGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx) as never
})

afterEach(() => {
  cleanup()
  HTMLCanvasElement.prototype.getContext = originalGetContext
  vi.unstubAllGlobals()
})

describe("OrbCanvas under prefers-reduced-motion: reduce", () => {
  beforeEach(() => stubReducedMotion(true))

  it("never starts an animation loop", () => {
    const raf = vi.fn(() => 1)
    vi.stubGlobal("requestAnimationFrame", raf)
    stubReducedMotion(true)

    render(<OrbCanvas state="idle" levelRef={levelRef} size={64} />)

    expect(raf).not.toHaveBeenCalled()
  })

  it("paints exactly once per state change", () => {
    const raf = vi.fn(() => 1)
    vi.stubGlobal("requestAnimationFrame", raf)
    stubReducedMotion(true)

    const view = render(<OrbCanvas state="idle" levelRef={levelRef} size={64} />)
    expect(paints()).toBe(1)

    view.rerender(<OrbCanvas state="thinking" levelRef={levelRef} size={64} />)
    expect(paints()).toBe(2)

    view.rerender(<OrbCanvas state="speaking" levelRef={levelRef} size={64} />)
    expect(paints()).toBe(3)
    expect(raf).not.toHaveBeenCalled()
  })

  it("still paints, so the orb reads as parked rather than as broken", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1))
    stubReducedMotion(true)

    render(<OrbCanvas state="listening" levelRef={levelRef} size={64} />)

    expect(ctx.createRadialGradient).toHaveBeenCalled()
    expect(ctx.fill).toHaveBeenCalledTimes(3)
  })
})

describe("OrbCanvas with motion allowed", () => {
  it("runs an animation loop and repaints on every frame", () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb))
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
    stubReducedMotion(false)

    render(<OrbCanvas state="idle" levelRef={levelRef} size={64} />)
    expect(frames).toHaveLength(1)
    expect(paints()).toBe(0)

    frames[0](16)
    expect(paints()).toBe(1)
    frames[1](32)
    expect(paints()).toBe(2)
  })

  it("cancels the loop when it unmounts", () => {
    const cancel = vi.fn()
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 7))
    vi.stubGlobal("cancelAnimationFrame", cancel)
    stubReducedMotion(false)

    render(<OrbCanvas state="idle" levelRef={levelRef} size={64} />).unmount()

    expect(cancel).toHaveBeenCalledWith(7)
  })

  it("scales the backing store by the device pixel ratio", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1))
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
    vi.stubGlobal("devicePixelRatio", 2)
    stubReducedMotion(false)

    const { container } = render(<OrbCanvas state="idle" levelRef={levelRef} size={64} />)

    const canvas = container.querySelector("canvas")!
    expect(canvas.width).toBe(128)
    expect(canvas.height).toBe(128)
    expect(ctx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0)
  })

  it("hides the canvas from assistive technology", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1))
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
    stubReducedMotion(false)

    const { container } = render(<OrbCanvas state="idle" levelRef={levelRef} size={64} />)

    expect(container.querySelector("canvas")).toHaveProperty("ariaHidden", "true")
  })
})
