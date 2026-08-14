import { currentSituation } from "../talk-situation-store"

/**
 * Finding the thing on the page the operator just named.
 *
 * The generic page tools have no idea what they are driving, which is the point
 * of them and also the danger: this module is where that danger is bounded.
 *
 * - Text is compared against what the page SAYS — its label, its placeholder,
 *   its own words — and never turned into a selector. A model that could name a
 *   selector would be addressing internals it cannot see, and one it got wrong
 *   would act on the wrong thing silently. Same rule as `focus-element.ts`.
 * - The orb's own surface is not addressable. Without that, a generic click
 *   could answer or dismiss the very consent card that was asked about it.
 * - Two matches is a refusal, never a pick. On a voice channel the operator has
 *   no way to notice that a silent choice was the wrong one.
 */

/** What a click or a keystroke may land on. Everything else on a page is text. */
const INTERACTIVE = 'button, a[href], input, textarea, select, [role="button"], [contenteditable=""], [contenteditable="true"]'

/** The orb's own DOM: the situation sheet with its scrim, the undo strip, and
 *  the orb itself. Each carries the attribute its component renders. */
const ORB_SURFACE = "[data-situation-phase], [data-talk-undo-strip], [data-talk-orb-overlay]"

/** Enough to read back so the operator can say which one they meant. */
const NAMED_CANDIDATES = 5

export type TargetMatch = { element: HTMLElement } | { error: string }

function normalize(value: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase()
}

/** Everything this element says about itself, in the operator's terms. */
function textsOf(element: HTMLElement): string[] {
  const said = [element.getAttribute("aria-label"), element.getAttribute("placeholder")]
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) said.push(element.value)
  else said.push(element.textContent)
  return said.map(normalize).filter((text) => text !== "")
}

/**
 * Hidden in the ways a page can express without being laid out. Box geometry
 * would be the fuller answer, but it is not measurable off a real renderer, and
 * a check that silently passes everything in one environment and gates in
 * another is worse than a narrower one that means the same thing in both.
 */
function hidden(element: HTMLElement): boolean {
  if (element.hasAttribute("hidden") || element.closest("[aria-hidden=\"true\"]")) return true
  const style = getComputedStyle(element)
  return style.display === "none" || style.visibility === "hidden"
}

function interactive(element: HTMLElement): boolean {
  return element.matches(INTERACTIVE)
}

/** What an element is, in the terms a spoken answer can use: the tag it is,
 *  what it says, and whether it can be acted on. */
export function elementSummary(element: HTMLElement): { tag: string; text: string; interactive: boolean } {
  const [said] = textsOf(element)
  return { tag: element.localName, text: said ?? "", interactive: interactive(element) }
}

/** How a refusal names one candidate. */
function describe(element: HTMLElement): string {
  const { tag, text } = elementSummary(element)
  return text ? `<${tag}> "${text}"` : `<${tag}>`
}

/** An element whose own match is really its child's — every ancestor up to the
 *  body "contains" the text, and a page is not ambiguous because it has a body. */
function innermost(found: readonly HTMLElement[]): HTMLElement[] {
  return found.filter((element) => !found.some((other) => other !== element && element.contains(other)))
}

/**
 * Everything on the page that says what was spoken, innermost only.
 *
 * An exact match wins over a containing one, so "Save" reaches the Save button
 * on a page that also has "Save and close" rather than refusing both.
 */
function matching(wanted: string, interactiveOnly: boolean): HTMLElement[] {
  const searched = interactiveOnly
    ? document.body.querySelectorAll<HTMLElement>(INTERACTIVE)
    : document.body.querySelectorAll<HTMLElement>("*")

  const exact: HTMLElement[] = []
  const partial: HTMLElement[] = []
  for (const element of searched) {
    if (element.closest(ORB_SURFACE) || hidden(element)) continue
    const texts = textsOf(element)
    if (texts.includes(wanted)) exact.push(element)
    else if (texts.some((text) => text.includes(wanted))) partial.push(element)
  }
  return innermost(exact.length > 0 ? exact : partial)
}

/** The element the spoken text names, or the reason there is not exactly one. */
export function resolveByText(spoken: string, options: { interactiveOnly: boolean }): TargetMatch {
  const wanted = normalize(spoken)
  if (wanted === "") return { error: "Say what the thing on screen is called — its label, its placeholder, or the words on it." }

  const found = matching(wanted, options.interactiveOnly)
  const only = found[0]
  if (!only) {
    return {
      error: `Nothing on this page ${options.interactiveOnly ? "that can be used " : ""}says "${spoken}". Read out what is there, or navigate to the page holding it first.`,
    }
  }
  if (found.length > 1) {
    const named = found.slice(0, NAMED_CANDIDATES).map(describe).join(", ")
    const rest = found.length > NAMED_CANDIDATES ? `, and ${found.length - NAMED_CANDIDATES} more` : ""
    return { error: `"${spoken}" matches ${found.length} things on this page: ${named}${rest}. Ask the operator which one they mean and name it exactly.` }
  }
  if (options.interactiveOnly && !interactive(only)) {
    return { error: `"${spoken}" is text on the page, not something that can be clicked or typed into.` }
  }
  return { element: only }
}

/** The one thing a generic action must check before anything else: a page the
 *  operator is being asked a question about is not a page to go driving. */
export function refusalWhileAsking(): string | null {
  return currentSituation()
    ? "The operator is being asked something right now. Nothing on the page was touched — wait for their answer before acting on it."
    : null
}

/** Between the sheet going up and the operator answering, the page can rerender
 *  the very thing that was asked about away. */
export function stillOnPage(element: HTMLElement, spoken: string): string | null {
  return element.isConnected ? null : `"${spoken}" left the page while the operator was answering, so nothing was done. Look again and say what is there now.`
}
