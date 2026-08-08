import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import {
  answerSituation,
  askSituation,
  dismissSituation,
  presentSituation,
  restoreDeferredSituation,
  useDeferredSituation,
  useSituation,
} from "../talk-situation-store"
import { PAYLOADS, clearSituations } from "./situation-fixtures"

const FIRST = { id: "s-1", title: "First", payload: PAYLOADS.prose }
const SECOND = { id: "s-2", title: "Second", payload: PAYLOADS.options }

afterEach(() => {
  act(() => clearSituations())
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

  // The one rule the two designs had to be reconciled on: dismissal means
  // "not now" for a situation that was raised, and "no" for one that was asked.
  it("does not defer an asked situation: a write waiting on consent is refused, not parked", async () => {
    const deferred = renderHook(() => useDeferredSituation())
    const answer = askSituation(FIRST)

    act(() => dismissSituation())

    await expect(answer).resolves.toBeNull()
    expect(deferred.result.current).toBeNull()
  })

  it("clears what an earlier dismissal deferred when an asked situation is answered", async () => {
    const deferred = renderHook(() => useDeferredSituation())

    act(() => presentSituation(SECOND))
    act(() => dismissSituation())
    const answer = askSituation(FIRST)

    act(() => answerSituation("ship"))

    await expect(answer).resolves.toBe("ship")
    expect(deferred.result.current).toBeNull()
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
    act(() => answerSituation("ship"))

    expect(deferred.result.current).toBeNull()
  })

  it("has nothing to raise when nothing was dismissed", () => {
    const current = renderHook(() => useSituation())

    act(() => restoreDeferredSituation())

    expect(current.result.current).toBeNull()
  })
})
