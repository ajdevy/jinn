import { api } from "@/lib/api"
import { askSituation } from "../talk-situation-store"
import { chatPath, experimentPath, todoPath, workflowPath } from "./nav-paths"
import { companyTodoPrefix, go } from "./navigate-tools"
import {
  looksLikeId,
  rankCandidates,
  searchTerm,
  spokenId,
  viewPrefix,
  type Candidate,
  type CandidateKind,
  type RankedCandidate,
} from "./resolve"
import { params, str, type TalkTool, type ToolArgs, type ToolResult } from "./tool-spec"

/**
 * One way in for "open the thing I just named".
 *
 * The operator says an id, a bare number, or their own words, and this turns
 * any of the three into a route. An id costs no request and commits its route
 * change with nothing awaited in front of it, like the navigation tools. Words
 * cost four searches, which is why they are the slower path — and when several
 * things fit them the sheet asks, because a voice channel gives the operator no
 * way to notice that a silent pick was the wrong one.
 */

/** Enough cards to choose between, few enough to hear read out. */
const SHEET_CARDS = 5
const SEARCH_LIMIT = 20

const KIND_LABEL: Record<CandidateKind, string> = {
  todo: "Todo",
  session: "Chat",
  workflow: "Workflow",
  experiment: "Experiment",
}

/** Distinct per ask, so the sheet keys its entrance on each new question. */
let asked = 0

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function pathFor(candidate: Candidate): string {
  switch (candidate.kind) {
    case "todo":
      return todoPath(candidate.id)
    case "session":
      return chatPath({ sessionId: candidate.id })
    case "workflow":
      return workflowPath({ id: candidate.id })
    case "experiment":
      return experimentPath({ id: candidate.id })
  }
}

/**
 * Everything the four surfaces can offer for one term, flattened.
 *
 * Workflows and experiments have no search route, so their lists come back
 * whole and `rankCandidates` does the narrowing. A source that fails takes the
 * whole resolution down with it rather than quietly shrinking the field: a
 * "nothing matched" that really meant "one search errored" would send the
 * operator looking for something that is there.
 */
async function candidatesFor(term: string): Promise<Candidate[]> {
  const [todos, sessions, workflows, experiments] = await Promise.all([
    api.searchWorkItems({ text: term, limit: SEARCH_LIMIT }),
    api.searchSessions(term),
    api.listWorkflowDefinitionsV2(),
    api.listExperiments(),
  ])
  return [
    ...todos.workItems.map((item) => ({ kind: "todo" as const, id: item.id, title: item.title, detail: item.status })),
    ...sessions.map((row) => ({ kind: "session" as const, id: text(row.id), title: text(row.title), detail: text(row.employee) })),
    ...workflows.items.map((item) => ({ kind: "workflow" as const, id: item.id, title: item.title })),
    ...experiments.experiments.map((item) => ({ kind: "experiment" as const, id: item.id, title: item.name, detail: item.status })),
  ]
}

/** The kind first, because two objects can carry the same title and only their
 *  kind tells the operator which of the two they are about to open. */
function card(candidate: RankedCandidate): { id: string; label: string; detail: string } {
  const kind = KIND_LABEL[candidate.kind]
  return {
    id: `${candidate.kind}:${candidate.id}`,
    label: candidate.title,
    detail: candidate.detail ? `${kind} · ${candidate.detail}` : kind,
  }
}

async function askWhichOne(what: string, ranked: readonly RankedCandidate[]): Promise<ToolResult> {
  const offered = ranked.slice(0, SHEET_CARDS)
  const cards = new Map(offered.map((candidate) => [card(candidate).id, candidate]))
  const hint = offered.length < ranked.length ? `${ranked.length} things match "${what}". These are the closest.` : undefined
  asked += 1

  const choice = await askSituation({
    id: `resolve-${asked}`,
    title: "Which one did you mean?",
    ...(hint ? { hint } : {}),
    payload: { kind: "options", options: offered.map(card) },
  })

  const picked = choice === null ? undefined : cards.get(choice)
  if (!picked) {
    return {
      ok: false,
      error: `Nothing was opened: the operator did not pick one of the ${offered.length} things matching "${what}". Ask them which one they meant.`,
    }
  }
  return go(pathFor(picked))
}

async function openByDescription(what: string): Promise<ToolResult> {
  const term = searchTerm(what)
  if (!term) {
    return { ok: false, error: `"${what}" names nothing to look for. Say a word from its title, or give the id.` }
  }

  let ranked: RankedCandidate[]
  try {
    ranked = rankCandidates(what, await candidatesFor(term))
  } catch (error) {
    const why = error instanceof Error && error.message ? error.message : "the gateway did not answer"
    return { ok: false, error: `Could not search for "${what}": ${why}.` }
  }

  const only = ranked[0]
  if (!only) {
    return { ok: false, error: `Nothing here matches "${what}", so nothing was opened. Say it another way, or give the id.` }
  }
  if (ranked.length === 1) return go(pathFor(only))
  return askWhichOne(what, ranked)
}

const resolveAndOpen: TalkTool = {
  name: "resolve_and_open",
  description:
    'Open whatever the operator just named — a Todo, a chat session, a workflow, or an experiment. Takes an id ("ABC-59"), a bare number ("59", meaning the namespace on screen), or their own words ("the talk orb one"). Asks which they meant when the words fit several things.',
  exposure: "always",
  parameters: params(
    { what: str("Exactly what the operator called it: the id, the bare number, or their own description.") },
    ["what"],
  ),
  execute: (args: ToolArgs): ToolResult | Promise<ToolResult> => {
    const what = String(args.what).trim()
    if (!looksLikeId(what)) return openByDescription(what)

    const resolved = spokenId(what, [viewPrefix(window.location.pathname), companyTodoPrefix()])
    if ("error" in resolved) return { ok: false, error: resolved.error }
    return go(todoPath(resolved.id))
  },
}

export const RESOLVE_TOOLS: readonly TalkTool[] = [resolveAndOpen]
