/**
 * Where the operator is, read straight off the URL.
 *
 * Almost every Jinn surface already keeps "what you are looking at" in the
 * location — the board and its filters, the open Todo, the workflow run, the
 * selected chat session — so the orb can be told without asking the page
 * anything. This is `tools/nav-paths.ts` in reverse, and it holds to the same
 * rule: nothing here invents state a page does not actually carry in its URL.
 *
 * Pure. No React, no DOM, no fetch — which is what lets the router publish a
 * snapshot from a subscription and lets every case be tested without a page.
 */
import { resolveDeepLink } from "@/components/chat/chat-route-helpers"
import { filtersFromSearchParams } from "@/lib/todos"
import { parseBoardParam, boardKey } from "@/routes/todos/board/board-route"
import { parseNotesLocation } from "@/routes/notes/notes-route"

/** The surface the operator is on. Named rather than left to be re-derived from
 *  the path, so that everything downstream — the renderer, the object lookup —
 *  branches on one closed set instead of parsing the URL again. */
export type PageKind =
  | "chat"
  | "todos"
  | "todo"
  | "workflows"
  | "workflow"
  | "workflow-run"
  | "experiments"
  | "experiment"
  | "org"
  | "cron"
  | "notes"
  | "other"

/** The one object this view is focused on: the Todo it opened, the run it is
 *  showing, the session chat has selected. `kind` is the operator's word for it,
 *  because the snapshot is read aloud rather than switched on. */
export interface PageSelection {
  kind: string
  id: string
}

export interface PageSnapshot {
  kind: PageKind
  /** The path exactly as the address bar has it. The one field an unrecognised
   *  route still fills, which is what "degrade, never throw" means here. */
  path: string
  /** What the path names beyond the selection — the board, the workflow a run
   *  belongs to, the folder a note sits in. */
  params: Readonly<Record<string, string>>
  /** Filters, sort and search, for the pages that keep them in the URL. */
  filters: Readonly<Record<string, string>>
  selection: PageSelection | null
}

/** Everything but the path, which `describeLocation` fills for every branch. */
type View = Omit<PageSnapshot, "path">

/** A path segment can be any bytes the operator pasted, and a lone `%` throws.
 *  A segment we cannot decode is still the segment they are looking at. */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function segmentsOf(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map(decode)
}

/** Only the entries that carry something. An empty string in the snapshot reads
 *  as a filter set to nothing, which is not what an absent one means. */
function present(entries: Array<[string, string | undefined | null]>): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [key, value] of entries) {
    const text = value?.trim()
    if (text) kept[key] = text
  }
  return kept
}

function todosView(rest: string[], params: URLSearchParams): View {
  // /todos/:todoId is the task page; /todos/b/:board and bare /todos are boards.
  const todoId = rest[0] === "b" ? undefined : rest[0]
  if (todoId) return { kind: "todo", params: {}, filters: {}, selection: { kind: "Todo", id: todoId } }

  const filters = filtersFromSearchParams(params)
  return {
    kind: "todos",
    params: { board: boardKey(parseBoardParam(rest[1])) },
    filters: present([
      ["status", filters.status],
      ["assignee", filters.assignee],
      ["department", filters.department],
      ["source", filters.source],
      ["date", filters.date],
      ["label", filters.label],
      ["due", filters.due],
      ["q", filters.q],
    ]),
    selection: null,
  }
}

function workflowView(rest: string[], params: URLSearchParams): View {
  const id = rest[0]
  if (!id) return { kind: "workflows", params: {}, filters: {}, selection: null }
  if (rest[1] === "runs" && rest[2]) {
    return { kind: "workflow-run", params: { workflow: id }, filters: {}, selection: { kind: "workflow run", id: rest[2] } }
  }
  // `editor` is the page's default lens and it writes no param for it, so the
  // runs lens is the only one ever in the URL to report.
  return {
    kind: "workflow",
    params: {},
    filters: present([["lens", params.get("lens") === "runs" ? "runs" : null]]),
    selection: { kind: "workflow", id },
  }
}

function chatView(params: URLSearchParams): View {
  // Same precedence the chat page itself resolves by: a session id beats an
  // employee, because it is the more specific intent.
  const link = resolveDeepLink(params)
  const selection =
    link?.kind === "session" ? { kind: "chat session", id: link.id }
    : link?.kind === "employee" ? { kind: "employee", id: link.name }
    : null
  return { kind: "chat", params: {}, filters: {}, selection }
}

function cronView(rest: string[], params: URLSearchParams): View {
  const jobId = rest[0]
  if (jobId) return { kind: "cron", params: {}, filters: {}, selection: { kind: "cron job", id: jobId } }
  return {
    kind: "cron",
    params: {},
    filters: present([["lens", params.get("lens")], ["filter", params.get("filter")]]),
    selection: null,
  }
}

function notesView(pathname: string): View {
  const notes = parseNotesLocation(pathname)
  return {
    kind: "notes",
    params: present([["folder", notes.folder]]),
    filters: {},
    selection: notes.notePath ? { kind: "note", id: notes.notePath } : null,
  }
}

/** A list route and its detail route differ only by whether the id is there. */
function listOrDetail(list: PageKind, detail: PageKind, selectionKind: string, id: string | undefined): View {
  if (!id) return { kind: list, params: {}, filters: {}, selection: null }
  return { kind: detail, params: {}, filters: {}, selection: { kind: selectionKind, id } }
}

/**
 * Describe a location. Anything unrecognised comes back as its path and nothing
 * else — a route this parser has not been taught is a page the orb should name
 * the path of, not a reason to take the conversation down.
 */
export function describeLocation(pathname: string, search: string): PageSnapshot {
  const params = new URLSearchParams(search)
  const [head, ...rest] = segmentsOf(pathname)

  const view = ((): View => {
    switch (head) {
      case undefined:
        return chatView(params)
      case "todos":
        return todosView(rest, params)
      case "workflow":
        return workflowView(rest, params)
      case "experiments":
        return listOrDetail("experiments", "experiment", "experiment", rest[0])
      case "cron":
        return cronView(rest, params)
      case "org":
        return listOrDetail("org", "org", "employee", params.get("employee")?.trim())
      case "notes":
        return notesView(pathname)
      default:
        return { kind: "other", params: {}, filters: {}, selection: null }
    }
  })()

  return { ...view, path: pathname }
}
