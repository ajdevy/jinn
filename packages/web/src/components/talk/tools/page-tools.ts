import { withConsent } from "./consent"
import { elementSummary, refusalWhileAsking, resolveByText, stillOnPage } from "./dom-target"
import { revealElement } from "./focus-element"
import { params, str, type TalkTool, type ToolArgs, type ToolResult } from "./tool-spec"

/**
 * Driving the page itself, for everything the app can do that no tool names.
 *
 * These are the least bounded actions the orb has — the model decides what they
 * mean by looking at words on a screen — so every one of them is situation-first,
 * including the two that only look. A read here is not the same as reading a
 * Todo: `find_element_by_text` and `scroll_to` are how the model learns what a
 * generic click would land on next, and a probe that costs nothing to make is a
 * probe worth making silently.
 *
 * Ambiguity refuses rather than picking, the orb's own surface is not reachable
 * (see `dom-target.ts`), and nothing runs at all while a situation is up.
 */

interface Ask {
  title: string
  hint?: string
  confirm: string
}

/**
 * The shape all four share: refuse while asking, resolve, let the tool veto,
 * ask, then act on an element that is still there.
 *
 * Resolution happens BEFORE the sheet so the sheet can name what was found
 * rather than what was said — the operator agrees to a click on a specific
 * button, not to the model's reading of a sentence.
 */
async function drive(
  tool: string,
  spoken: string,
  options: { interactiveOnly: boolean; veto?: (element: HTMLElement) => string | null },
  ask: (element: HTMLElement) => Ask,
  act: (element: HTMLElement) => ToolResult,
): Promise<ToolResult> {
  const asking = refusalWhileAsking()
  if (asking) return { ok: false, error: asking }

  const match = resolveByText(spoken, { interactiveOnly: options.interactiveOnly })
  if ("error" in match) return { ok: false, error: match.error }

  const vetoed = options.veto?.(match.element)
  if (vetoed) return { ok: false, error: vetoed }

  const { title, hint, confirm } = ask(match.element)
  return withConsent(
    { tool, title, ...(hint ? { hint } : {}), confirm, subject: null },
    () => {
      const gone = stillOnPage(match.element, spoken)
      return Promise.resolve(gone ? { ok: false, error: gone } : act(match.element))
    },
  )
}

const clickByText: TalkTool = {
  name: "click_by_text",
  description:
    "Click something on the page by the words on it — a button, a link, a tab. Asks the operator first, and refuses when the words fit more than one thing.",
  parameters: params({ text: str("The words on the thing to click, as the page shows them.") }, ["text"]),
  execute: (args: ToolArgs): Promise<ToolResult> => {
    const text = String(args.text)
    return drive(
      "click_by_text",
      text,
      { interactiveOnly: true },
      (element) => ({
        title: `Click "${elementSummary(element).text || text}"?`,
        hint: "It does whatever that control does on this page, which the orb cannot see in advance or take back.",
        confirm: "Click it",
      }),
      (element) => {
        element.click()
        return { ok: true, data: { performed: `Clicked "${elementSummary(element).text || text}".` } }
      },
    )
  },
}

/** Set the value the way a person would, so a controlled field notices. Writing
 *  `value` directly leaves React's own tracker holding the old string and the
 *  app never hears about the change. */
function enter(element: HTMLElement, text: string): void {
  element.focus()
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const native = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element) as object, "value")?.set
    if (native) native.call(element, text)
    else element.value = text
    element.dispatchEvent(new Event("input", { bubbles: true }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
    return
  }
  element.textContent = text
  element.dispatchEvent(new Event("input", { bubbles: true }))
}

/** A spoken password is a password said out loud in a room, transcribed by a
 *  third party, and typed by a model. None of those three is a thing to do with
 *  one, and no page needs voice to fill this field. */
function notAPasswordField(element: HTMLElement): string | null {
  return element instanceof HTMLInputElement && element.type === "password"
    ? "That is a password field, and the orb does not type into one. Tell the operator to type it themselves."
    : null
}

const typeInto: TalkTool = {
  name: "type_into",
  description:
    "Type into a field on the page, found by its label or placeholder. Replaces what is in it. Asks the operator first, and never types into a password field.",
  parameters: params(
    {
      field: str("What the field is called on screen — its label, its placeholder, or the words in it."),
      text: str("What to type, in the operator's words."),
    },
    ["field", "text"],
  ),
  execute: (args: ToolArgs): Promise<ToolResult> => {
    const field = String(args.field)
    const text = String(args.text)
    return drive(
      "type_into",
      field,
      { interactiveOnly: true, veto: notAPasswordField },
      () => ({ title: `Type this into "${field}"?`, hint: text, confirm: "Type it" }),
      (element) => {
        enter(element, text)
        return { ok: true, data: { performed: `Typed it into "${field}".` } }
      },
    )
  },
}

const findElementByText: TalkTool = {
  name: "find_element_by_text",
  description:
    "Check whether something is on the page and whether it can be clicked, by the words on it. Asks the operator first, like every generic page action.",
  parameters: params({ text: str("The words to look for, as the page shows them.") }, ["text"]),
  execute: (args: ToolArgs): Promise<ToolResult> => {
    const text = String(args.text)
    return drive(
      "find_element_by_text",
      text,
      { interactiveOnly: false },
      () => ({ title: `Look for "${text}" on this page?`, confirm: "Look" }),
      (element) => ({ ok: true, data: { ...elementSummary(element) } }),
    )
  },
}

const scrollTo: TalkTool = {
  name: "scroll_to",
  description:
    "Scroll something into view and mark it, by the words on it, so the operator can see which one is meant. Asks first, like every generic page action.",
  parameters: params({ text: str("The words on the thing to scroll to, as the page shows them.") }, ["text"]),
  execute: (args: ToolArgs): Promise<ToolResult> => {
    const text = String(args.text)
    return drive(
      "scroll_to",
      text,
      { interactiveOnly: false },
      () => ({ title: `Scroll to "${text}"?`, confirm: "Scroll to it" }),
      (element) => {
        revealElement(element)
        return { ok: true, data: { performed: `Scrolled to "${text}".`, ...elementSummary(element) } }
      },
    )
  },
}

export const PAGE_TOOLS: readonly TalkTool[] = [clickByText, typeInto, findElementByText, scrollTo]
