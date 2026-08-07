import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FOCUS_HIGHLIGHT_CLASS, FOCUS_HIGHLIGHT_MS, TALK_TARGET_ATTRIBUTE } from "../focus-element"
import { executeToolCall } from "../registry"

vi.mock("@/lib/api", () => ({ api: {} }))

const scrolled: ScrollIntoViewOptions[] = []

function target(name: string) {
  const element = document.createElement("div")
  element.setAttribute(TALK_TARGET_ATTRIBUTE, name)
  element.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => {
    scrolled.push(options as ScrollIntoViewOptions)
  }
  document.body.append(element)
  return element
}

function reducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("reduce"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
}

beforeEach(() => {
  vi.useFakeTimers()
  scrolled.length = 0
  reducedMotion(false)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
})

describe("focus_element", () => {
  it("scrolls the named element into view and marks it for the length of the gesture", async () => {
    const element = target("ABC-59")

    const result = await executeToolCall("focus_element", '{"target":"ABC-59"}')

    expect(result).toEqual({ ok: true, data: { target: "ABC-59" } })
    expect(scrolled).toEqual([{ behavior: "smooth", block: "center" }])
    expect(element.classList.contains(FOCUS_HIGHLIGHT_CLASS)).toBe(true)

    vi.advanceTimersByTime(FOCUS_HIGHLIGHT_MS + 1)
    expect(element.classList.contains(FOCUS_HIGHLIGHT_CLASS)).toBe(false)
  })

  it("does not animate the scroll when motion is reduced", async () => {
    target("ABC-59")
    reducedMotion(true)

    await executeToolCall("focus_element", '{"target":"ABC-59"}')

    expect(scrolled).toEqual([{ behavior: "auto", block: "center" }])
  })

  it("restarts the mark instead of letting the first timer clear it early", async () => {
    const element = target("ABC-59")

    await executeToolCall("focus_element", '{"target":"ABC-59"}')
    vi.advanceTimersByTime(FOCUS_HIGHLIGHT_MS - 200)
    await executeToolCall("focus_element", '{"target":"ABC-59"}')
    vi.advanceTimersByTime(300)

    expect(element.classList.contains(FOCUS_HIGHLIGHT_CLASS)).toBe(true)
  })

  it("says how a thing becomes focusable when it cannot find one", async () => {
    const result = await executeToolCall("focus_element", '{"target":"nothing-here"}')
    expect(result).toEqual({ ok: false, error: expect.stringContaining("talk target") })
  })

  it("does not let a target name escape its selector", async () => {
    target("plain")
    const result = await executeToolCall("focus_element", '{"target":"plain\\"], [data-talk-target"}')
    expect(result.ok).toBe(false)
  })
})
