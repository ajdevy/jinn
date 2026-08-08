import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  UNDO_WINDOW_MS,
  forgetUndo,
  offerUndo,
  pendingUndo,
  takeUndo,
  useUndoOffer,
} from "../talk-undo-store"

const COMMENTED = "Commented on AAA-1"
const LABELLED = "Labelled AAA-2"

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  forgetUndo()
  vi.useRealTimers()
})

describe("the undo window", () => {
  it("holds the offer for the full fifteen seconds, and not a millisecond longer", () => {
    expect(UNDO_WINDOW_MS).toBe(15_000)
    offerUndo(COMMENTED, vi.fn(async () => {}))

    vi.advanceTimersByTime(UNDO_WINDOW_MS - 1)
    expect(pendingUndo()).not.toBeNull()

    vi.advanceTimersByTime(1)
    expect(pendingUndo()).toBeNull()
  })

  it("lets the write stand when the window lapses, rather than reversing it behind the operator", () => {
    const reverse = vi.fn(async () => {})
    offerUndo(COMMENTED, reverse)

    vi.advanceTimersByTime(UNDO_WINDOW_MS * 2)

    expect(reverse).not.toHaveBeenCalled()
  })

  it("dates the offer so the strip can count down from the same clock", () => {
    const offer = offerUndo(COMMENTED, vi.fn(async () => {}))

    expect(offer.expiresAt - Date.now()).toBe(UNDO_WINDOW_MS)
  })
})

describe("taking the undo", () => {
  it("runs the reversal once and reports what it took back", async () => {
    const reverse = vi.fn(async () => {})
    offerUndo(COMMENTED, reverse)

    await expect(takeUndo()).resolves.toEqual({ ok: true, performed: COMMENTED })
    expect(reverse).toHaveBeenCalledTimes(1)
    expect(pendingUndo()).toBeNull()
  })

  it("says why it cannot when nothing is on the table", async () => {
    const outcome = await takeUndo()

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.error).toMatch(/nothing to undo/i)
  })

  it("says the change is still in place when the reversal is refused, and does not leave the button up to retry", async () => {
    offerUndo(COMMENTED, async () => {
      throw new Error("the gateway refused")
    })

    const outcome = await takeUndo()

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.error).toContain("the gateway refused")
    expect(outcome.ok === false && outcome.error).toContain("The change is still in place.")
    expect(pendingUndo()).toBeNull()
  })
})

describe("one offer at a time", () => {
  it("replaces the first offer, whose write then stands", async () => {
    const first = vi.fn(async () => {})
    const second = vi.fn(async () => {})

    offerUndo(COMMENTED, first)
    offerUndo(LABELLED, second)

    await expect(takeUndo()).resolves.toEqual({ ok: true, performed: LABELLED })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it("forgets an offer without running it, the same as lapsing", () => {
    const reverse = vi.fn(async () => {})
    offerUndo(COMMENTED, reverse)

    forgetUndo()

    expect(pendingUndo()).toBeNull()
    expect(reverse).not.toHaveBeenCalled()
  })
})

describe("the offer a surface subscribes to", () => {
  it("reaches every subscriber, and tells them when it lapses", () => {
    const one = renderHook(() => useUndoOffer())
    const two = renderHook(() => useUndoOffer())

    act(() => {
      offerUndo(COMMENTED, vi.fn(async () => {}))
    })
    expect(one.result.current?.performed).toBe(COMMENTED)
    expect(two.result.current?.performed).toBe(COMMENTED)

    act(() => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS)
    })
    expect(one.result.current).toBeNull()
    expect(two.result.current).toBeNull()
  })
})
