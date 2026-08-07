import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { dismissSituation, presentSituation, useSituation } from "../talk-situation-store"
import { PAYLOADS } from "./situation-fixtures"

const FIRST = { id: "s-1", title: "First", payload: PAYLOADS.prose }
const SECOND = { id: "s-2", title: "Second", payload: PAYLOADS.options }

afterEach(() => {
  act(() => dismissSituation())
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
