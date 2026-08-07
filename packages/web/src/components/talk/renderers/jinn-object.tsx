import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { queryKeys } from "@/lib/query-keys"
import { useTodoById } from "@/routes/todos/use-todos"
import type { AnswerHandler, JinnObjectRef, SituationPayload } from "../situation-payload"
import { SituationCard } from "./situation-card"

type ObjectPayload = Extract<SituationPayload, { kind: "object" }>

/**
 * A live thing in this instance, drawn from the same queries its own page uses,
 * so the card cannot show a stale or invented version of it. It loads, it says
 * so; it fails, it says why. It never renders an empty card and calls that fine.
 */

interface ObjectSummary {
  /** What sort of thing this is, for the eyebrow line. */
  kindLabel: string
  title: string
  detail: string
}

interface ObjectState {
  loading: boolean
  error: string | null
  summary: ObjectSummary | null
}

const LOADING: ObjectState = { loading: true, error: null, summary: null }

/** A non-empty string, or nothing. Blank fields are missing data, not values. */
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null
}

function failed(error: unknown): ObjectState {
  const why = error instanceof Error && error.message ? error.message : "the gateway did not answer"
  return { loading: false, error: why, summary: null }
}

function loaded(summary: ObjectSummary): ObjectState {
  return { loading: false, error: null, summary }
}

function useTodoState(id: string | null): ObjectState {
  const todo = useTodoById(id)
  if (todo.isPending) return LOADING
  if (todo.error) return failed(todo.error)
  if (!todo.data) return { loading: false, error: `${id} no longer exists`, summary: null }
  const item = todo.data.workItem
  return loaded({
    kindLabel: `Todo · ${item.id}`,
    title: item.title,
    detail: [item.status.replace("_", " "), item.assignee].filter(Boolean).join(" · "),
  })
}

function useSessionState(id: string, enabled: boolean): ObjectState {
  const session = useQuery({
    queryKey: queryKeys.sessions.detail(id),
    enabled,
    queryFn: ({ signal }) => api.getSession(id, { messages: false, signal }),
  })
  if (session.isPending) return LOADING
  if (session.error) return failed(session.error)
  const data = session.data ?? {}
  return loaded({
    kindLabel: "Session",
    title: text(data.title) ?? id,
    detail: [text(data.employee), text(data.status)].filter(Boolean).join(" · ") || id,
  })
}

function useRunState(workflowId: string, runId: string, enabled: boolean): ObjectState {
  const run = useQuery({
    queryKey: queryKeys.workflows.run(workflowId, runId),
    enabled,
    queryFn: () => api.getWorkflowRunV2(workflowId, runId),
  })
  if (run.isPending) return LOADING
  if (run.error) return failed(run.error)
  return loaded({
    kindLabel: "Workflow run",
    title: run.data?.workflowTitle ?? workflowId,
    detail: [run.data?.status, runId].filter(Boolean).join(" · "),
  })
}

/**
 * Every query runs as a hook on every render — only the one matching the ref is
 * enabled, because hooks cannot be called conditionally.
 */
function useJinnObject(ref: JinnObjectRef): ObjectState {
  const todo = useTodoState(ref.type === "todo" ? ref.id : null)
  const session = useSessionState(ref.type === "session" ? ref.id : "", ref.type === "session")
  const run = useRunState(
    ref.type === "workflowRun" ? ref.workflowId : "",
    ref.type === "workflowRun" ? ref.id : "",
    ref.type === "workflowRun",
  )
  if (ref.type === "todo") return todo
  if (ref.type === "session") return session
  return run
}

export function ObjectSituation({
  payload,
  onAnswer,
}: {
  payload: ObjectPayload
  onAnswer: AnswerHandler
}) {
  const { loading, error, summary } = useJinnObject(payload.object)

  return (
    <div data-situation-renderer="object">
      <SituationCard
        choiceId={payload.object.id}
        onAnswer={onAnswer}
        busy={loading}
        disabled={loading || error !== null}
      >
        {loading && (
          <span className="block text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
            Loading {payload.object.id}…
          </span>
        )}
        {error && (
          <span
            data-situation-object-error
            className="block text-[length:var(--text-footnote)] text-[var(--system-red)]"
          >
            Couldn&rsquo;t load {payload.object.id} — {error}.
          </span>
        )}
        {summary && (
          <>
            <span className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              {summary.kindLabel}
            </span>
            <span className="mt-0.5 block font-[var(--weight-medium)]">{summary.title}</span>
            {summary.detail && (
              <span className="mt-0.5 block text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
                {summary.detail}
              </span>
            )}
          </>
        )}
      </SituationCard>
    </div>
  )
}

const SPOKEN_KIND: Record<JinnObjectRef["type"], string> = {
  todo: "Todo",
  session: "session",
  workflowRun: "workflow run",
}

export function objectSpeech(payload: ObjectPayload): string {
  return `${SPOKEN_KIND[payload.object.type]} ${payload.object.id}`
}
