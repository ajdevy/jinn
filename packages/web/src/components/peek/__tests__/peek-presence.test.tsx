import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { usePeekPresence } from "../peek-panel"
import type { PeekEntry } from "../peek-stack"

const FIRST: PeekEntry = { kind: "todo", id: "ICI-1" }
const SECOND: PeekEntry = { kind: "todo", id: "ICI-2" }

/** The hook asks the panel what animation it is running. jsdom computes no
 *  animations at all, so each test states the answer it wants to exercise. */
function stubExitAnimation(animationName: string): void {
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    animationName,
  } as CSSStyleDeclaration)
}

function renderPresence(open: PeekEntry | undefined) {
  const panel = document.createElement("aside")
  return renderHook(({ entry }: { entry: PeekEntry | undefined }) => usePeekPresence(entry, panel), {
    initialProps: { entry: open },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("usePeekPresence", () => {
  it("keeps the closing entry rendered while its exit animation runs", () => {
    stubExitAnimation("jinn-rail-out")
    const { result, rerender } = renderPresence(FIRST)

    act(() => rerender({ entry: undefined }))

    expect(result.current.entry).toEqual(FIRST)
    expect(result.current.state).toBe("closed")
  })

  it("drops the closing entry once the exit animation reports back", () => {
    stubExitAnimation("jinn-rail-out")
    const { result, rerender } = renderPresence(FIRST)
    act(() => rerender({ entry: undefined }))

    act(() => result.current.onExitEnd())

    expect(result.current.entry).toBeUndefined()
  })

  it("drops it in the same commit when there is no exit animation to wait for", () => {
    // Reduced motion switches the animation off, so no animationend will ever
    // fire — holding the entry for one would strand the panel on screen.
    stubExitAnimation("none")
    const { result, rerender } = renderPresence(FIRST)

    act(() => rerender({ entry: undefined }))

    expect(result.current.entry).toBeUndefined()
  })

  it("cancels the exit when the panel reopens mid-close", () => {
    stubExitAnimation("jinn-rail-out")
    const { result, rerender } = renderPresence(FIRST)
    act(() => rerender({ entry: undefined }))

    act(() => rerender({ entry: SECOND }))

    expect(result.current.entry).toEqual(SECOND)
    expect(result.current.state).toBe("open")
  })

  it("stays closed after a release rather than resurrecting the entry", () => {
    stubExitAnimation("jinn-rail-out")
    const { result, rerender } = renderPresence(FIRST)
    act(() => rerender({ entry: undefined }))
    act(() => result.current.onExitEnd())

    act(() => rerender({ entry: undefined }))

    expect(result.current.entry).toBeUndefined()
  })
})
