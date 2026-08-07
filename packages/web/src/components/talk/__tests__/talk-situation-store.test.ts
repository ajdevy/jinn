import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import {
  answerSituation,
  askSituation,
  dismissSituation,
  presentSituation,
  useSituation,
} from "../talk-situation-store"
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

describe("asking a situation", () => {
  it("hands back the id of the card the operator picked", async () => {
    const answer = askSituation(FIRST)

    act(() => answerSituation("ship"))

    await expect(answer).resolves.toBe("ship")
  })

  it("hands back null when it is dismissed, which a gated write reads as a refusal", async () => {
    const answer = askSituation(FIRST)

    act(() => dismissSituation())

    await expect(answer).resolves.toBeNull()
  })

  it("hands back null when a second situation replaces it, so no asker is left waiting forever", async () => {
    const answer = askSituation(FIRST)

    act(() => presentSituation(SECOND))

    await expect(answer).resolves.toBeNull()
  })

  it("still raises one fire-and-forget, for callers with nothing to wait on", () => {
    const { result } = renderHook(() => useSituation())

    act(() => presentSituation(FIRST))
    expect(result.current).toBe(FIRST)

    act(() => answerSituation("ship"))
    expect(result.current).toBeNull()
  })
})
