import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import {
  dismissSituation,
  presentSituation,
  resolveSituation,
  restoreDeferredSituation,
  useDeferredSituation,
  useSituation,
} from "../talk-situation-store"
import { PAYLOADS } from "./situation-fixtures"

const FIRST = { id: "s-1", title: "First", payload: PAYLOADS.prose }
const SECOND = { id: "s-2", title: "Second", payload: PAYLOADS.options }

// Resolving, not dismissing: a dismissal is what fills the deferred slot, so
// clearing up with one would leak the previous test's situation into the next.
afterEach(() => {
  act(() => resolveSituation())
})

describe("the situation store", () => {
  it("starts empty", () => {
    const { result } = renderHook(() => useSituation())
    expect(result.current).toBeNull()
  })

  it("raises a situation and takes it down again", () => {
    const { result } = renderHook(() => useSituation())

    act(() => presentSituation(FIRST))
    expect(result.current).toBe(FIRST)

    act(() => dismissSituation())
    expect(result.current).toBeNull()
  })

  it("holds one at a time: a second replaces the first", () => {
    const { result } = renderHook(() => useSituation())

    act(() => presentSituation(FIRST))
    act(() => presentSituation(SECOND))

    expect(result.current).toBe(SECOND)
  })

  it("reaches every subscriber, not just the one that raised it", () => {
    const one = renderHook(() => useSituation())
    const two = renderHook(() => useSituation())

    act(() => presentSituation(FIRST))

    expect(one.result.current).toBe(FIRST)
    expect(two.result.current).toBe(FIRST)
  })
})

describe("deferring a situation instead of destroying it", () => {
  it("keeps a dismissed situation whole, and raises the same one again", () => {
    const current = renderHook(() => useSituation())
    const deferred = renderHook(() => useDeferredSituation())

    act(() => presentSituation(FIRST))
    act(() => dismissSituation())

    expect(current.result.current).toBeNull()
    expect(deferred.result.current).toBe(FIRST)

    act(() => restoreDeferredSituation())

    expect(current.result.current?.id).toBe(FIRST.id)
    expect(current.result.current?.payload).toBe(FIRST.payload)
    expect(deferred.result.current).toBeNull()
  })

  it("clears the deferred slot on an answer: a decision made is not pending", () => {
    const deferred = renderHook(() => useDeferredSituation())

    act(() => presentSituation(FIRST))
    act(() => dismissSituation())
    act(() => presentSituation(SECOND))
    act(() => resolveSituation())

    expect(deferred.result.current).toBeNull()
  })

  it("has nothing to raise when nothing was dismissed", () => {
    const current = renderHook(() => useSituation())

    act(() => restoreDeferredSituation())

    expect(current.result.current).toBeNull()
  })
})
