/**
 * The snapshot, in the words the model reads.
 *
 * This owns the size of ambient context. The text is pushed as the session's
 * `instructions`, a replaced field, so it costs its length once rather than once
 * per turn — but a page with four hundred cards on it would still be four
 * hundred cards of it, so the budget is enforced here and the object list is the
 * only part allowed to give ground.
 */
import { clip } from "../tools/read-shapes"
import type { PageKind, PageSnapshot } from "./page-snapshot"
import type { InstanceIdentity } from "./instance-identity"
import type { VisibleObject } from "./visible-objects"

/**
 * ~300 tokens at the gateway's documented four-chars-per-token estimate
 * (`talk/session/context.ts`), against its `TALK_CONTEXT_BUDGET_TOKENS` of 6000.
 */
export const PAGE_CONTEXT_BUDGET_CHARS = 1200

/** Long enough for a real Todo title, short enough that a dozen of them fit. */
const TITLE_CHARS = 60
/** The route, a filter value or an id, capped so no single operator-typed string
 *  can eat the budget the rest of the snapshot needs. */
const VALUE_CHARS = 120

const SURFACE_LABEL: Record<PageKind, string> = {
  chat: "Chat",
  todos: "Todos board",
  todo: "Todo",
  workflows: "Workflows",
  workflow: "Workflow editor",
  "workflow-run": "Workflow run",
  experiments: "Experiments",
  experiment: "Experiment",
  org: "Org",
  cron: "Cron",
  notes: "Notes",
  other: "Page",
}

const PREAMBLE =
  "What the operator is looking at right now, in their Jinn web UI. "
  + "This is live page context: it is replaced whenever they move, and it is not something they said to you."

function pairs(entries: Readonly<Record<string, string>>): string {
  return Object.entries(entries)
    .map(([key, value]) => `${key}=${clip(value, VALUE_CHARS)}`)
    .join(", ")
}

/** The lines that are never traded away for room: which Jinn, which page, which
 *  filters, what is selected. */
function fixedLines(snapshot: PageSnapshot, instance: InstanceIdentity): string[] {
  const lines = [
    PREAMBLE,
    `Instance: ${clip(instance.name, VALUE_CHARS)} on port ${clip(instance.port, VALUE_CHARS)}`,
    `Page: ${SURFACE_LABEL[snapshot.kind]} at ${clip(snapshot.path, VALUE_CHARS)}`,
  ]
  const route = pairs(snapshot.params)
  if (route) lines.push(`Route: ${route}`)
  // Selection before filters: both are clipped field by field and so both fit
  // in every real case, but a page carrying an absurd number of filters is
  // clamped from the tail, and the filters are the part that may go.
  if (snapshot.selection) {
    lines.push(`Selected: ${snapshot.selection.kind} ${clip(snapshot.selection.id, VALUE_CHARS)}`)
  }
  const filters = pairs(snapshot.filters)
  if (filters) lines.push(`Filters: ${filters}`)
  return lines
}

function entryFor(object: VisibleObject): string {
  const title = clip(object.title, TITLE_CHARS)
  return title ? `${object.id} ${title}` : object.id
}

/** The object line carrying exactly `shown` of them, and an honest count of the
 *  rest. Truncation is stated: a model that reads a cut list as the whole board
 *  answers "twelve Todos" for a board of four hundred. */
function objectLine(objects: readonly VisibleObject[], shown: number): string {
  const dropped = objects.length - shown
  const listed = objects.slice(0, shown).map(entryFor)
  if (dropped > 0) listed.push(`+${dropped} more`)
  return `On screen (${shown} of ${objects.length}): ${listed.join("; ")}`
}

/**
 * Render one snapshot, inside the budget.
 *
 * The fixed lines are clipped field by field, so they are bounded before any
 * budget arithmetic happens; the object list then takes whatever room is left,
 * one entry at a time, and is dropped whole if there is none.
 */
export function renderPageContext(
  snapshot: PageSnapshot,
  objects: readonly VisibleObject[],
  instance: InstanceIdentity,
): string {
  const fixed = fixedLines(snapshot, instance).join("\n").slice(0, PAGE_CONTEXT_BUDGET_CHARS)
  if (objects.length === 0) return fixed

  let best = ""
  for (let shown = 1; shown <= objects.length; shown += 1) {
    const line = objectLine(objects, shown)
    if (fixed.length + 1 + line.length > PAGE_CONTEXT_BUDGET_CHARS) break
    best = line
  }
  return best === "" ? fixed : `${fixed}\n${best}`
}
