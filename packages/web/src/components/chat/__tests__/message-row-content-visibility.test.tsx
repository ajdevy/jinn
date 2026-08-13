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

describe("chat message row scrolling", () => {
  it("lets offscreen message rows skip layout and paint", () => {
    const messages: Message[] = [{
      id: "message-1",
      role: "user",
      content: "A short message",
      timestamp: 100,
    }]

    const { container } = render(<ChatMessages messages={messages} loading={false} />)
    const row = container.querySelector<HTMLElement>('[data-message-id="message-1"]')

    expect(row?.style.contentVisibility).toBe("auto")
    expect(row?.style.containIntrinsicSize).toBe("auto 120px")
  })

  it("drops it once windowed, where a skipped row would report a placeholder height", () => {
    // `content-visibility: auto` makes the ResizeObserver see contain-intrinsic-size
    // instead of the row, so the virtualizer would cache 120px for every row and
    // put every offset below it in the wrong place.
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
