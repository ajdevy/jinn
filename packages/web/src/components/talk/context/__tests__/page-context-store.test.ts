import { afterEach, describe, expect, it, vi } from "vitest"
import { describeLocation } from "../page-snapshot"
import { buildScreenContext } from "../surface-adapters"
import {
  getPageContext,
  publishScreenContext,
  resetPageContext,
  subscribePageContext,
} from "../page-context-store"

function semantic(text: string, capturedAt: string) {
  const root = document.createElement("main")
  root.innerHTML = `<h1>${text}</h1>`
  return buildScreenContext({
    location: describeLocation("/logs", ""),
    browserInstanceId: "browser-1",
    root,
    capturedAt,
  })
}

afterEach(resetPageContext)

describe("semantic page context publication", () => {
  it("increments the revision only for a meaningful same-route change", () => {
    const listener = vi.fn()
    subscribePageContext(listener)

    publishScreenContext(semantic("Activity Console", "2026-08-18T08:00:00.000Z"))
    const firstRevision = getPageContext().revision
    publishScreenContext(semantic("Activity Console", "2026-08-18T08:01:00.000Z"))
    publishScreenContext(semantic("Activity Console · one error", "2026-08-18T08:01:01.000Z"))

    expect(listener).toHaveBeenCalledTimes(2)
    expect(getPageContext().revision).toBe(firstRevision + 1)
    expect(getPageContext().meaningfulText).toContain("one error")
  })
})
