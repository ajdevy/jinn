import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronDown, ChevronRight, MessageCircle, X } from "lucide-react"
import { Link } from "react-router-dom"
import { MarkdownView } from "@/components/markdown-view"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { api, type WorkflowAttemptWire, type WorkflowNodeRunWire, type WorkflowRunDetailWire } from "@/lib/api"
import { queryKeys } from "@/lib/query-keys"
import { useTheme } from "@/routes/providers"
import { ApprovalDecision, type ApprovalDecisionExtra } from "./approval-decision"
import { InspectorShell } from "./editor/inspector"
import { NodeTypeIcon } from "./editor/node-icons"
import { NODE_TYPE_LABEL, conditionCases, conditionDefaultPort, fixedBinding, type WorkflowNodeOfType, type WorkflowNodeWire } from "./editor/ports"
import { AttemptCard } from "./run-attempt-card"
import { FieldsTable } from "./run-fields"
import { ErrorNote, Note, Section, StatusLine, deriveNodeStatus, formatDuration, formatStarted, latestAttempt } from "./run-support"

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre
      className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-[10px] bg-[var(--fill-quaternary)] px-3 py-2.5 text-[length:var(--text-caption1)] leading-[1.55] text-[var(--text-secondary)]"
      style={{ fontFamily: "var(--font-code)" }}
      data-scrollable="true"
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

/* ── section building blocks ──────────────────────────────────────────────── */

function fixedEmployee(node: WorkflowNodeWire): string | null {
  return node.type === "employee" ? fixedBinding(node.config.employee) : null
}

function StepSection({ node, attempt }: { node: WorkflowNodeWire; attempt: WorkflowAttemptWire | undefined }) {
  const config = attempt?.resolvedConfig
  const employeeId = config?.employeeId ?? fixedEmployee(node)
  if (!employeeId) return null
  const rows: Array<{ label: string; value: string }> = config
    ? [
        { label: "Engine", value: config.engine },
        ...(config.model ? [{ label: "Model", value: config.model }] : []),
        ...(config.effort ? [{ label: "Effort", value: config.effort }] : []),
      ]
    : []
  return (
    <Section title="Step">
      <div className="overflow-hidden rounded-[10px] bg-[var(--fill-quaternary)]">
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <EmployeeAvatar name={employeeId} size={28} className="bg-[var(--fill-secondary)]" />
          <span className="min-w-0 flex-1 truncate text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
            {employeeId}
          </span>
        </div>
        {rows.map((row) => (
          <div key={row.label} className="flex gap-3 border-t border-[var(--separator)] px-3 py-2">
            <span className="w-[92px] shrink-0 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              {row.label}
            </span>
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-caption1)] text-[var(--text-primary)]">
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </Section>
  )
}

function ChildRunsSection({ detail, nodeId }: { detail: WorkflowRunDetailWire; nodeId: string }) {
  const children = (detail.childRuns ?? [])
    .filter((child) => child.nodeId === nodeId)
    .sort((a, b) => (a.itemIndex ?? -1) - (b.itemIndex ?? -1))
  if (children.length === 0) return null
  return (
    <Section title="Child runs">
      <div className="overflow-hidden rounded-[10px] bg-[var(--fill-quaternary)]">
        {children.map((child) => (
          <Link
            key={child.runId}
            to={`/workflow/${encodeURIComponent(child.workflowId)}/runs/${encodeURIComponent(child.runId)}`}
            className="flex min-h-10 items-center gap-2.5 border-b border-[var(--separator)] px-3 py-2 transition-colors last:border-b-0 hover:bg-[var(--fill-tertiary)]"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)]">
                {child.itemIndex === undefined ? child.workflowId : `Item ${child.itemIndex + 1}`}
              </span>
              <span
                className="block truncate text-[length:var(--text-caption2)] text-[var(--text-quaternary)]"
                style={{ fontFamily: "var(--font-code)" }}
              >
                {child.runId}
              </span>
            </span>
            <StatusLine status={child.status} />
            <ChevronRight size={14} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden />
          </Link>
        ))}
      </div>
    </Section>
  )
}

/** The composed prompt handed to the session — monospace and scrollable,
 *  collapsed behind a disclosure when it runs long. */
function PromptSection({ text }: { text: string }) {
  const lines = text.split("\n").length
  const long = lines > 20
  const [open, setOpen] = useState(!long)
  return (
    <Section title="Prompt">
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="mb-1.5 inline-flex items-center gap-1 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        >
          {open
            ? <ChevronDown size={12} strokeWidth={2.25} aria-hidden />
            : <ChevronRight size={12} strokeWidth={2.25} aria-hidden />}
          {open ? "Hide prompt" : `Show prompt · ${lines} lines`}
        </button>
      )}
      {open && (
        <pre
          className="max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-[10px] bg-[var(--fill-quaternary)] px-3 py-2.5 text-[length:var(--text-caption1)] leading-[1.55] text-[var(--text-secondary)]"
          style={{ fontFamily: "var(--font-code)" }}
          data-scrollable="true"
        >
          {text}
        </pre>
      )}
    </Section>
  )
}

function isEmptyRecord(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0
}

function OutputSection({ output, isDark }: {
  output: { text: string; fields: Record<string, unknown> } | undefined
  isDark: boolean
}) {
  if (!output || (Object.keys(output.fields).length === 0 && !output.text)) return null
  return (
    <Section title="Output">
      <div className="space-y-2">
        <FieldsTable fields={output.fields} />
        {output.text && (
          <div className="rounded-[10px] bg-[var(--fill-quaternary)] px-3 py-2.5 text-[length:var(--text-caption1)]">
            <MarkdownView content={output.text} isDark={isDark} />
          </div>
        )}
      </div>
    </Section>
  )
}

const SESSION_STATUS: Record<string, { label: string; color: string; pulse?: boolean }> = {
  running: { label: "Running", color: "var(--system-blue)", pulse: true },
  idle: { label: "Idle", color: "var(--text-quaternary)" },
  waiting: { label: "Waiting", color: "var(--system-orange)" },
  error: { label: "Error", color: "var(--system-red)" },
  interrupted: { label: "Interrupted", color: "var(--system-orange)" },
}

function SessionStatusChip({ status }: { status: string }) {
  const meta = SESSION_STATUS[status] ?? {
    label: status.charAt(0).toUpperCase() + status.slice(1),
    color: "var(--text-quaternary)",
  }
  return (
    <span
      className="inline-flex shrink-0 items-center gap-[5px] text-[length:var(--text-caption1)] font-[var(--weight-medium)]"
      style={{ color: meta.color }}
    >
      <span
        aria-hidden
        className={`size-1.5 rounded-full ${meta.pulse ? "animate-[jinn-pulse_1.4s_infinite] motion-reduce:animate-none" : ""}`}
        style={{ backgroundColor: meta.color }}
      />
      {meta.label}
    </span>
  )
}

function SessionSection({ sessionId }: { sessionId: string }) {
  const query = useQuery({
    queryKey: queryKeys.sessions.detail(sessionId),
    queryFn: () => api.getSession(sessionId, { messages: false }),
  })
  const status = typeof query.data?.["status"] === "string" ? (query.data["status"] as string) : null
  return (
    <Section title="Session">
      <Link
        to={`/?session=${encodeURIComponent(sessionId)}`}
        className="flex items-center gap-2.5 rounded-[10px] bg-[var(--fill-quaternary)] px-3 py-2.5 transition-colors hover:bg-[var(--fill-tertiary)]"
      >
        <MessageCircle size={15} className="shrink-0 text-[var(--text-secondary)]" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)]">
            Open chat session
          </span>
          <span
            className="block truncate text-[length:var(--text-caption2)] text-[var(--text-quaternary)]"
            style={{ fontFamily: "var(--font-code)" }}
          >
            {sessionId}
          </span>
        </span>
        {status && <SessionStatusChip status={status} />}
        <ChevronRight size={14} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden />
      </Link>
    </Section>
  )
}

function RouteSection({ node, nodeRun }: { node: WorkflowNodeWire; nodeRun: WorkflowNodeRunWire | undefined }) {
  const port = nodeRun?.output?.fields?.["port"]
  if (typeof port !== "string") return null
  const label = conditionCases(node).find((item) => item.port === port)?.label
    ?? (port === conditionDefaultPort(node) ? "else" : port)
  return (
    <Section title="Route">
      <Note>
        Routed to{" "}
        <span className="rounded-full bg-[var(--fill-tertiary)] px-2 py-0.5 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] text-[var(--text-secondary)]">
          {label}
        </span>
      </Note>
    </Section>
  )
}

/** The Todo a wait is bound to, when it is a comment-wait: this mode resumes on
 *  the operator's comment and keeps resumeAt only as its timeout deadline. */
function commentWaitTodoId(nodeRun: WorkflowNodeRunWire | undefined): string | null {
  const config = nodeRun?.resolvedConfig
  if (config?.["mode"] !== "todo-comment") return null
  const todoId = config["todoId"]
  return typeof todoId === "string" ? todoId : null
}

/** What the fan-out was told to run at once, and the narrower number the machine
 *  allowed — so a planner's degree is never implied to have been honoured. */
function FanoutSection({ nodeRun }: { nodeRun: WorkflowNodeRunWire | undefined }) {
  const requested = nodeRun?.resolvedConfig?.["concurrency"]
  const effective = nodeRun?.resolvedConfig?.["concurrencyEffective"]
  if (typeof requested !== "number") return null
  return (
    <Section title="Fan-out">
      <Note>
        {typeof effective === "number" && effective < requested
          ? `${requested} requested · ${effective} at a time (system ceiling)`
          : `${requested} at a time`}
      </Note>
    </Section>
  )
}

function triggerCaption(config: WorkflowNodeOfType<"trigger">["config"]): string {
  switch (config.kind) {
    case "schedule":
      return config.cron ? `Schedule · ${config.cron}` : "Schedule"
    case "event": return "On event"
    case "todo-status": return "On Todo status"
    case "workflow-call": return "Called by workflow"
    default: return "Manual"
  }
}

/* ── the inspector ────────────────────────────────────────────────────────── */

export function RunInspector({ detail, nodeId, onClose, onDecide, deciding }: {
  detail: WorkflowRunDetailWire
  nodeId: string
  onClose: () => void
  onDecide: (nodeId: string, decision: "approve" | "reject", extra?: ApprovalDecisionExtra) => void
  deciding: boolean
}) {
  const { theme } = useTheme()
  const isDark = useMemo(() => {
    if (typeof document !== "undefined") {
      const attr = document.documentElement.getAttribute("data-theme")
      if (attr) return attr !== "light"
    }
    return theme !== "light"
  }, [theme])

  const node = detail.definition.nodes.find((item) => item.id === nodeId)
  if (!node) return null
  const nodeRun = detail.nodeRuns.find((item) => item.nodeId === nodeId)
  const attempts = detail.attempts
    .filter((attempt) => attempt.nodeId === nodeId)
    .sort((a, b) => a.attempt - b.attempt)
  const latest = latestAttempt(attempts)
  const approval = detail.approvals.find((item) => item.nodeId === nodeId)
  const status = deriveNodeStatus(nodeRun, attempts)
  const commentWaitTodo = commentWaitTodoId(nodeRun)
  const output = nodeRun?.output ?? latest?.output
  const sessionId = latest?.sessionId ?? output?.sessionId

  return (
    <InspectorShell onDismiss={onClose}>
      <div className="flex h-full min-h-0 flex-col" data-testid="run-inspector">
        <div className="flex items-center gap-2.5 px-4 pb-2 pt-3.5">
          <NodeTypeIcon type={node.type} node={node} size={26} iconSize={13} />
          <span className="flex-1 text-[length:var(--text-caption1)] font-[var(--weight-semibold)] uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
            {NODE_TYPE_LABEL[node.type]}
          </span>
          <button
            type="button"
            aria-label="Close run details"
            onClick={onClose}
            className="grid size-8 place-items-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]"
          >
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4" data-scrollable="true">
          <div>
            <p className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
              {node.name}
            </p>
            <div className="mt-1 flex items-center gap-2.5">
              <StatusLine status={status} />
              {nodeRun?.startedAt && (
                <span
                  className="text-[length:var(--text-caption1)] text-[var(--text-quaternary)] [font-variant-numeric:tabular-nums]"
                  style={{ fontFamily: "var(--font-code)" }}
                >
                  {formatDuration(nodeRun.startedAt, nodeRun.endedAt)}
                </span>
              )}
            </div>
          </div>
          {nodeRun?.error && <ErrorNote message={nodeRun.error.message} />}
          {node.type === "trigger" && (
            <Section title="Fires on">
              <Note>{triggerCaption(node.config)}</Note>
            </Section>
          )}
          {node.type === "employee" && (
            <>
              <StepSection node={node} attempt={latest} />
              {latest?.promptText && <PromptSection text={latest.promptText} />}
              {nodeRun?.input !== undefined && (
                <Section title="Step input">
                  {isEmptyRecord(nodeRun.input)
                    ? <Note>No input</Note>
                    : <JsonBlock value={nodeRun.input} />}
                </Section>
              )}
              <OutputSection output={output} isDark={isDark} />
              {attempts.length > 0 && (
                <Section title={attempts.length === 1 ? "Attempt" : "Attempts"}>
                  <div className="space-y-2">
                    {attempts.map((attempt) => (
                      <AttemptCard key={attempt.attempt} attempt={attempt} />
                    ))}
                  </div>
                </Section>
              )}
              {sessionId && <SessionSection sessionId={sessionId} />}
            </>
          )}
          {node.type === "workflow-call" && (
            <>
              <FanoutSection nodeRun={nodeRun} />
              <OutputSection output={nodeRun?.output} isDark={isDark} />
            </>
          )}
          <ChildRunsSection detail={detail} nodeId={node.id} />
          {node.type === "condition" && <RouteSection node={node} nodeRun={nodeRun} />}
          {node.type === "approval" && approval && (
            <ApprovalDecision
              node={node}
              approval={approval}
              onDecide={onDecide}
              deciding={deciding}
              choice={nodeRun?.output?.choice}
            />
          )}
          {/* A settled comment-wait says nothing: the node keeps its resumeAt and
              resolvedConfig after it resumes, and neither "waiting" nor "resumes"
              is true of a step that already continued on a comment. */}
          {node.type === "wait" && nodeRun?.resumeAt
            && (commentWaitTodo === null || nodeRun.status === "waiting") && (
            <Section title="Wait">
              {commentWaitTodo
                ? (
                  <Note>
                    Waiting for your comment on {commentWaitTodo} · times out {formatStarted(nodeRun.resumeAt)}
                  </Note>
                )
                : <Note>Resumes {formatStarted(nodeRun.resumeAt)}</Note>}
            </Section>
          )}
          {node.type === "end" && (
            <>
              <Section title="Result">
                <Note>{node.config.result === "failure" ? "Failure" : "Success"}</Note>
              </Section>
              <OutputSection output={nodeRun?.output} isDark={isDark} />
            </>
          )}
          <p
            className="pt-1 text-[length:var(--text-caption2)] text-[var(--text-quaternary)]"
            style={{ fontFamily: "var(--font-code)" }}
          >
            {node.id}
          </p>
        </div>
      </div>
    </InspectorShell>
  )
}
