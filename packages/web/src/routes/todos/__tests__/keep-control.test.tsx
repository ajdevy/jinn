import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire, WorkItemStatusWire } from "@/lib/api"
import { KeepToggle, KeptCaption, keptCaptionOf } from "../board/keep-control"

/* ICI-1357 — the Home board's two affordances: the pin that puts a Todo there
 * and the caption that says whose work a kept Todo is. */

function compact(over: Partial<WorkItemCompactWire> & { id: string }): WorkItemCompactWire {
  return {
    title: `Item ${over.id}`,
    status: "backlog" as WorkItemStatusWire,
    assignee: null,
    department: "platform",
    source: "human",
    sourceRef: null,
    approvalState: null,
    approvalRequest: null,
    approvalRef: null,
    approvalTarget: null,
    approvalEscalatedAt: null,
    createdBy: "session:agent-1",
    parentId: null,
    rootId: over.id,
    depth: 0,
    dueAt: null,
    labels: [],
    blocked: false,
    updatedAt: "2026-08-21T08:00:00.000Z",
    rank: null,
    ...over,
  }
}

describe("the keep toggle", () => {
  it("is a button whose accessible name states the action and the current state", () => {
    const { rerender } = render(<KeepToggle id="PLA-1" onToggle={() => {}} />)
    const off = screen.getByTestId("keep-toggle-PLA-1")
    expect(off.tagName).toBe("BUTTON")
    expect(off.getAttribute("type")).toBe("button")
    expect(off.getAttribute("aria-label")).toBe("Keep PLA-1 on Home")
    expect(off.getAttribute("aria-pressed")).toBe("false")

    rerender(<KeepToggle id="PLA-1" kept onToggle={() => {}} />)
    const on = screen.getByTestId("keep-toggle-PLA-1")
    expect(on.getAttribute("aria-label")).toBe("Kept on Home — remove PLA-1 from Home")
    expect(on.getAttribute("aria-pressed")).toBe("true")
  })

  it("asks for the opposite of the state it is showing", () => {
    const onToggle = vi.fn()
    const { rerender } = render(<KeepToggle id="PLA-2" onToggle={onToggle} />)
    screen.getByTestId("keep-toggle-PLA-2").click()
    expect(onToggle).toHaveBeenCalledWith({ id: "PLA-2", kept: true })

    rerender(<KeepToggle id="PLA-2" kept onToggle={onToggle} />)
    screen.getByTestId("keep-toggle-PLA-2").click()
    expect(onToggle).toHaveBeenLastCalledWith({ id: "PLA-2", kept: false })
  })

  it("is reachable by keyboard: focusable, and not hidden from the tab order", () => {
    render(<KeepToggle id="PLA-3" onToggle={() => {}} />)
    const button = screen.getByTestId("keep-toggle-PLA-3")
    expect(button.getAttribute("tabindex")).toBeNull() // a button is tabbable by default
    expect(button.getAttribute("aria-hidden")).toBeNull()
    button.focus()
    expect(document.activeElement).toBe(button)
  })

  // Criterion 8: the pointer crossing a card must not resize it. The control is
  // always mounted at a fixed size and only its OPACITY changes, so it occupies
  // its box whether or not it is showing.
  it("occupies its box in both states, and reveals itself on hover and on focus", () => {
    const { rerender } = render(<KeepToggle id="PLA-4" revealOnHover onToggle={() => {}} />)
    const off = screen.getByTestId("keep-toggle-PLA-4")
    expect(off.className).toContain("size-[22px]")
    expect(off.className).toContain("opacity-0")
    expect(off.className).toContain("group-hover:opacity-100")
    expect(off.className).toContain("focus-visible:opacity-100")

    rerender(<KeepToggle id="PLA-4" kept revealOnHover onToggle={() => {}} />)
    const on = screen.getByTestId("keep-toggle-PLA-4")
    expect(on.className).toContain("size-[22px]")
    expect(on.className).not.toContain("opacity-0")
  })

  // The task page's toolbar has no hover group to belong to, so a control that
  // waited for one would be invisible until it happened to take focus.
  it("shows at rest wherever there is no hover group, kept or not", () => {
    render(<KeepToggle id="PLA-12" onToggle={() => {}} />)
    const button = screen.getByTestId("keep-toggle-PLA-12")
    expect(button.className).not.toContain("opacity-0")
    expect(button.className).not.toContain("group-hover:")
  })

  it("keeps a click off the card underneath it", () => {
    const onCardClick = vi.fn()
    const onToggle = vi.fn()
    render(
      <div onClick={onCardClick}>
        <KeepToggle id="PLA-5" onToggle={onToggle} />
      </div>,
    )
    screen.getByTestId("keep-toggle-PLA-5").click()
    expect(onToggle).toHaveBeenCalledOnce()
    expect(onCardClick).not.toHaveBeenCalled()
  })
})

/* Criterion 7: Home mixes provenance, so a kept Todo somebody else raised has
 * to say so — and must never say it with a hole in the sentence. */
describe("the Kept · <department> caption", () => {
  it("names the department of a kept Todo the operator did not raise", () => {
    expect(keptCaptionOf(compact({ id: "PLA-6", kept: true, department: "platform" }))).toBe("Kept · Platform")
    expect(keptCaptionOf(compact({ id: "OPS-1", kept: true, department: "customer-success" })))
      .toBe("Kept · Customer Success")
  })

  it("says nothing about a Todo the operator raised themselves", () => {
    expect(keptCaptionOf(compact({ id: "PLA-7", kept: true, createdBy: "operator" }))).toBeNull()
  })

  it("says nothing about a Todo that is not kept", () => {
    expect(keptCaptionOf(compact({ id: "PLA-8", kept: false }))).toBeNull()
    expect(keptCaptionOf(compact({ id: "PLA-9" }))).toBeNull()
  })

  it("renders no caption at all rather than `Kept · undefined` when there is no department", () => {
    const item = compact({ id: "PLA-10", kept: true, department: null })
    expect(keptCaptionOf(item)).toBeNull()
    render(<KeptCaption item={item} />)
    expect(screen.queryByTestId("kept-caption-PLA-10")).toBeNull()
    expect(document.body.textContent).not.toContain("undefined")
  })

  it("renders the caption when there is one", () => {
    render(<KeptCaption item={compact({ id: "PLA-11", kept: true, department: "growth" })} />)
    expect(screen.getByTestId("kept-caption-PLA-11").textContent).toContain("Kept · Growth")
  })
})
