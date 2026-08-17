import type { SemanticControl } from "./page-snapshot"

export const TALK_PRIVATE_SELECTORS = [
  "[data-talk-orb-overlay]",
  "[data-situation-phase]",
  "[data-talk-undo-strip]",
  "[data-talk-secret]",
  "[aria-hidden='true']",
  "input[type='password']",
  "[autocomplete='current-password']",
  "[autocomplete='new-password']",
] as const

const TEXT_LIMIT = 1_200
const CONTROL_LIMIT = 24

function privateElement(element: Element): boolean {
  return TALK_PRIVATE_SELECTORS.some((selector) => element.matches(selector) || element.closest(selector) !== null)
}

function clipped(value: string, limit: number): string {
  const clean = value.replace(/\s+/g, " ").trim()
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`
}

function labelOf(element: Element): string {
  const aria = element.getAttribute("aria-label")
  if (aria) return clipped(aria, 120)
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const label = element.labels?.[0]?.textContent
    return clipped(label || element.placeholder || element.name, 120)
  }
  return clipped(element.textContent ?? "", 120)
}

function operationOf(element: Element): string {
  if (element instanceof HTMLAnchorElement) return "navigate"
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return "edit"
  if (element instanceof HTMLSelectElement) return "select"
  return element.getAttribute("role") === "tab" ? "select-tab" : "activate"
}

export function collectControls(root: HTMLElement): SemanticControl[] {
  const controls: SemanticControl[] = []
  const candidates = root.querySelectorAll("button, a[href], input, select, textarea, [role='button'], [role='tab']")
  for (const element of candidates) {
    if (privateElement(element) || (element as HTMLElement).hidden) continue
    const label = labelOf(element)
    if (!label) continue
    const target = element.getAttribute("data-talk-target") ?? undefined
    controls.push({ label, operation: operationOf(element), ...(target ? { target } : {}) })
    if (controls.length >= CONTROL_LIMIT) break
  }
  return controls
}

export function collectMeaningfulText(root: HTMLElement): string {
  const parts: string[] = []
  const seen = new Set<string>()
  const candidates = root.querySelectorAll("h1, h2, h3, [data-talk-context], [role='status'], main p, main li")
  for (const element of candidates) {
    if (privateElement(element) || (element as HTMLElement).hidden) continue
    const text = clipped(element.textContent ?? "", 400)
    if (!text || seen.has(text)) continue
    seen.add(text)
    parts.push(text)
    if (parts.join("\n").length >= TEXT_LIMIT) break
  }
  return clipped(parts.join("\n"), TEXT_LIMIT)
}

export function collectVisualGaps(root: HTMLElement): string[] {
  const gaps = new Set<string>()
  for (const element of root.querySelectorAll("[data-talk-visual-gap]")) {
    if (privateElement(element)) continue
    const gap = element.getAttribute("data-talk-visual-gap")?.trim()
    if (gap) gaps.add(gap)
  }
  return [...gaps]
}

export function describeFocus(root: HTMLElement): { tag: string; label: string } | null {
  const focused = document.activeElement
  if (!focused || !root.contains(focused) || privateElement(focused)) return null
  const label = labelOf(focused)
  return { tag: focused.tagName.toLowerCase(), label }
}

/** Remove private nodes and live form values before a clone crosses a renderer boundary. */
export function sanitizedClone(root: HTMLElement): HTMLElement {
  const clone = root.cloneNode(true) as HTMLElement
  for (const selector of TALK_PRIVATE_SELECTORS) {
    for (const element of clone.querySelectorAll(selector)) element.remove()
  }
  for (const element of clone.querySelectorAll("input, textarea, select")) {
    element.removeAttribute("value")
    if (element instanceof HTMLTextAreaElement) element.textContent = ""
  }
  return clone
}
