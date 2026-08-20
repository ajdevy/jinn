import { render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Message } from "@/lib/conversations"
import { ChatMessages } from "../chat-messages"
import { installVirtualLayout } from "./virtual-layout"

const longThread: Message[] = Array.from({ length: 200 }, (_, i) => ({
  id: `message-${i}`,
  role: (i % 2 === 0 ? "user" : "assistant") as Message["role"],
  content: `A short message ${i}`,
  timestamp: 100 + i * 1000,
}))

afterEach(() => { vi.restoreAllMocks() })

/**
 * `content-visibility: auto` skips an offscreen row's layout, and the row then
 * reports `contain-intrinsic-size` instead of itself. A flat estimate for every
 * row means each one re-measures the first time it comes into view, which moves
 * the content above the reader mid-scroll — the drag going sticky is that shift
 * fighting the finger. A transcript short enough to render every row has nothing
 * to save by skipping any of them, and a long one is windowed instead.
 */
describe("chat message row scrolling", () => {
  it("keeps a message row measuring itself, so it cannot resize under the reader", () => {
    const messages: Message[] = [{
      id: "message-1",
      role: "user",
      content: "A short message",
      timestamp: 100,
    }]

    const { container } = render(<ChatMessages messages={messages} loading={false} />)
    const row = container.querySelector<HTMLElement>('[data-message-id="message-1"]')

    expect(row).toBeTruthy()
    expect(row?.style.contentVisibility).toBe("")
    expect(row?.style.containIntrinsicSize).toBe("")
  })

  it("holds once windowed, where a skipped row would report a placeholder height", () => {
    // Same reason, sharper consequence: the virtualizer's ResizeObserver would
    // cache contain-intrinsic-size for every row and put every offset below it
    // in the wrong place.
    const layout = installVirtualLayout(120, 800)
    const { container } = render(<ChatMessages messages={longThread} loading={false} />)
    const rows = container.querySelectorAll<HTMLElement>("[data-message-id]")

    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.style.contentVisibility).toBe("")
      expect(row.style.containIntrinsicSize).toBe("")
    }
    layout.release()
  })
})
