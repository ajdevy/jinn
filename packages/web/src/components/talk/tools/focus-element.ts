import { params, str, type TalkTool, type ToolArgs, type ToolResult } from "./tool-spec"

/**
 * Scroll a named thing into view and mark it, so "that one" has a referent the
 * operator can see. The only user-visible surface in this module.
 *
 * A thing is addressable when it carries `data-talk-target`. That is deliberate:
 * a voice caller naming an arbitrary CSS selector would be guessing at internals
 * it cannot see, and an unfound target is a clearer failure than a wrong one.
 */

export const TALK_TARGET_ATTRIBUTE = "data-talk-target"
export const FOCUS_HIGHLIGHT_CLASS = "talk-focus"
/** Long enough to find with the eye, short enough not to become chrome. */
export const FOCUS_HIGHLIGHT_MS = 1600

const clearing = new WeakMap<Element, ReturnType<typeof setTimeout>>()

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** Matched by comparing attribute values rather than by building a selector out
 *  of a name a model spoke, which cannot be escaped wrong. */
function findTarget(target: string): Element | undefined {
  const marked = document.querySelectorAll(`[${TALK_TARGET_ATTRIBUTE}]`)
  for (const element of marked) {
    if (element.getAttribute(TALK_TARGET_ATTRIBUTE) === target) return element
  }
  return undefined
}

/** Scroll something into view and mark it. Shared with the generic page tools,
 *  so "that one" looks the same however the element was named. */
export function revealElement(element: Element): void {
  element.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" })

  // Re-focusing the same element restarts the mark rather than stacking a second
  // timer that would clear it early.
  const pending = clearing.get(element)
  if (pending !== undefined) {
    clearTimeout(pending)
    element.classList.remove(FOCUS_HIGHLIGHT_CLASS)
    // Reading offsetWidth flushes the removal, so the animation restarts.
    void (element as HTMLElement).offsetWidth
  }
  element.classList.add(FOCUS_HIGHLIGHT_CLASS)
  clearing.set(
    element,
    setTimeout(() => {
      element.classList.remove(FOCUS_HIGHLIGHT_CLASS)
      clearing.delete(element)
    }, FOCUS_HIGHLIGHT_MS),
  )
}

export function focusElement(target: string): ToolResult {
  const element = findTarget(target)
  if (!element) {
    return {
      ok: false,
      error: `Nothing on this page is named "${target}". Only elements the app marks as talk targets can be focused; navigate to the page holding it first.`,
    }
  }

  revealElement(element)
  return { ok: true, data: { target } }
}

export const FOCUS_ELEMENT_TOOL: TalkTool = {
  name: "focus_element",
  description:
    "Scroll to something on the current page and highlight it, so the operator can see which one is meant. Use after navigating.",
  parameters: params({ target: str("The name the app gives the element, such as a Todo id.") }, ["target"]),
  execute: (args: ToolArgs) => focusElement(String(args.target)),
}
