import type { QueryKey } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { queryClient } from "@/lib/query-client"
import { queryKeys } from "@/lib/query-keys"
import { trimExperiment, trimSession, trimTodo, trimWorkflowRuns } from "./read-shapes"
import { params, str, type TalkTool, type ToolArgs, type ToolResult } from "./tool-spec"

/**
 * Reads over company state, served from the cache the app's own pages fill.
 *
 * Each tool reads the exact query key its page uses, so the page and the orb can
 * never disagree about what is true. A present entry answers immediately even
 * once it is stale: the operator is asking about what is on their screen, and a
 * refetch would stall a voice turn on the network to re-learn it. Only a genuine
 * miss goes to `fetchQuery`, which fills that same entry.
 */

/**
 * `answers` guards keys the app fills with a PARTIAL shape. A page that fetched
 * a session with `messages: false` leaves an entry that cannot say what was
 * said, and returning it would read out "no messages" for a busy session. That
 * entry is a miss, so `staleTime: 0` makes the refetch actually happen and fill
 * the same key with the whole object.
 */
async function cached<T>(key: QueryKey, fetch: () => Promise<T>, answers?: (held: T) => boolean): Promise<T> {
  const held = queryClient.getQueryData<T>(key)
  if (held !== undefined && (answers?.(held) ?? true)) return held
  return queryClient.fetchQuery({ queryKey: key, queryFn: fetch, staleTime: 0 })
}

/** The two keys a session's rows arrive under — `trimSession` reads either. */
function carriesMessages(held: unknown): boolean {
  const session = (held ?? {}) as Record<string, unknown>
  return Array.isArray(session.messages) || Array.isArray(session.history)
}

function failed(subject: string, error: unknown): ToolResult {
  const why = error instanceof Error && error.message ? error.message : "the gateway did not answer"
  return { ok: false, error: `Could not read ${subject}: ${why}.` }
}

const readTodo: TalkTool = {
  name: "read_todo",
  description: "Read one Todo: its status, assignee, labels, body, and most recent comments.",
  exposure: "always",
  parameters: params(
    { id: str("The full Todo id, such as \"ABC-59\"."), comments: { type: "boolean", description: "Include the recent comments. Defaults to true." } },
    ["id"],
  ),
  execute: async (args: ToolArgs): Promise<ToolResult> => {
    const id = String(args.id)
    try {
      const detail = await cached(["work-item", id], () => api.getWorkItem(id))
      if (!detail) return { ok: false, error: `Todo ${id} does not exist.` }
      return { ok: true, data: trimTodo(detail, args.comments !== false) }
    } catch (error) {
      return failed(`Todo ${id}`, error)
    }
  },
}

const readSession: TalkTool = {
  name: "read_session",
  description: "Read one chat session: who is on it, whether it is running, and the last few messages.",
  exposure: "on-intent",
  parameters: params({ id: str("The session id.") }, ["id"]),
  execute: async (args: ToolArgs): Promise<ToolResult> => {
    const id = String(args.id)
    try {
      const raw = await cached(
        queryKeys.sessions.detail(id),
        () => api.getSession(id, { last: 6 }),
        (held) => carriesMessages(held),
      )
      return { ok: true, data: trimSession(raw as Record<string, unknown>, id) }
    } catch (error) {
      return failed(`session ${id}`, error)
    }
  },
}

const readWorkflowRuns: TalkTool = {
  name: "read_workflow_runs",
  description: "Read a workflow's recent runs: status, what triggered each, and where a live or failed one stopped.",
  exposure: "on-intent",
  parameters: params(
    { id: str("The workflow id."), limit: { type: "integer", description: "How many runs, newest first. Defaults to 5." } },
    ["id"],
  ),
  execute: async (args: ToolArgs): Promise<ToolResult> => {
    const id = String(args.id)
    const limit = typeof args.limit === "number" ? Math.min(Math.max(args.limit, 1), 20) : 5
    try {
      const page = await cached(queryKeys.workflows.runs(id), () => api.listWorkflowRunsV2(id))
      return { ok: true, data: { workflowId: id, runs: trimWorkflowRuns(page.items, limit) } }
    } catch (error) {
      return failed(`runs of workflow ${id}`, error)
    }
  },
}

const readExperiment: TalkTool = {
  name: "read_experiment",
  description: "Read one experiment: its hypothesis, baseline, metrics, recent readings, and verdict if it has concluded.",
  exposure: "on-intent",
  parameters: params({ id: str("The experiment id.") }, ["id"]),
  execute: async (args: ToolArgs): Promise<ToolResult> => {
    const id = String(args.id)
    try {
      const response = await cached(["experiments", id], () => api.getExperiment(id))
      return { ok: true, data: trimExperiment(response) }
    } catch (error) {
      return failed(`experiment ${id}`, error)
    }
  },
}

export const READ_TOOLS: readonly TalkTool[] = [readTodo, readSession, readWorkflowRuns, readExperiment]
