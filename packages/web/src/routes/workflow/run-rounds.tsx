import { ChevronRight } from "lucide-react"
import { Link } from "react-router-dom"
import type { WorkflowChildRunV2Wire, WorkflowRunDetailV2Wire } from "@/lib/api"
import { FieldsTable } from "./run-fields"
import { Section, StatusLine, iterationRounds } from "./run-support"

/**
 * What a Workflow Call node's children did, one row each.
 *
 * For an iterating call a child is a round, and a round has to stand on its own:
 * its status, what it returned, and the session it ran in. Collapsing them into
 * one result would hide the thing iteration exists to make visible — that round
 * 3 said something round 1 did not.
 */

function RoundRow({ child, label }: { child: WorkflowChildRunV2Wire; label: string }) {
  const output = child.endOutput ?? {}
  return (
    <div className="border-b border-[var(--separator)] last:border-b-0">
      <Link
        to={`/workflow/${encodeURIComponent(child.workflowId)}/runs/${encodeURIComponent(child.runId)}`}
        className="flex min-h-10 items-center gap-2.5 px-3 py-2 transition-colors hover:bg-[var(--fill-tertiary)]"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)]">
            {label}
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
      {child.sessionId && (
        <Link
          to={`/?session=${encodeURIComponent(child.sessionId)}`}
          className="block truncate px-3 pb-1.5 text-[length:var(--text-caption2)] text-[var(--accent)] hover:underline"
          style={{ fontFamily: "var(--font-code)" }}
        >
          {child.sessionId}
        </Link>
      )}
      {Object.keys(output).length > 0 && (
        <div className="px-3 pb-2">
          <FieldsTable fields={output} />
        </div>
      )}
    </div>
  )
}

export function ChildRunsSection({ detail, nodeId }: { detail: WorkflowRunDetailV2Wire; nodeId: string }) {
  const children = (detail.childRuns ?? []).filter((child) => child.nodeId === nodeId).sort((a, b) => (a.itemIndex ?? -1) - (b.itemIndex ?? -1))
  const rounds = iterationRounds(detail.nodeRuns?.find((node) => node.nodeId === nodeId))
  if (children.length === 0) return null
  return (
    <Section title={rounds ? `Rounds \u00b7 ${rounds.round} of ${rounds.maxRounds}` : "Child runs"}>
      <div className="overflow-hidden rounded-[10px] bg-[var(--fill-quaternary)]">
        {children.map((child) => (
          <RoundRow key={child.runId} child={child} label={child.itemIndex === undefined ? child.workflowId : `${rounds ? "Round" : "Item"} ${child.itemIndex + 1}`} />
        ))}
      </div>
    </Section>
  )
}
