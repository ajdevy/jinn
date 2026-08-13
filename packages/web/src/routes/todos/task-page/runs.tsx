import type { WorkItemRunHandoffWire, WorkItemRunOutcomeWire, WorkItemRunWire } from "@/lib/api"
import { formatRelativeTime } from "../util"

/* ICI-728 — the run ledger section: one quiet row per attempt, oldest first,
 * the order the gateway serves them and the order a reviewer reads them in.
 * Nothing here is editable — a run is a record of what happened, not a
 * property. An OPEN attempt reads as in-flight in the StateLine grammar (the
 * pulsing blue dot, "Running", no outcome word) because it has not reported an
 * outcome and the section must not invent one. The handoff below a row is the
 * evidence a reviewer reads; it shows the fields the attempt actually filled
 * in and stays silent about the rest. */

const OUTCOME_LABEL: Record<WorkItemRunOutcomeWire, string> = {
  completed: "Completed",
  blocked: "Blocked",
  crashed: "Crashed",
  timed_out: "Timed out",
  abandoned: "Abandoned",
  rate_limited: "Rate limited",
}

/** The disc takes a colour only as the honest state it presents: green for an
 *  attempt that finished, red for one that died, neutral for one let go, and
 *  yellow for one the provider turned away — a wait, not a fault. */
const OUTCOME_TINT: Record<WorkItemRunOutcomeWire, string> = {
  completed: "var(--system-green)",
  blocked: "var(--system-orange)",
  crashed: "var(--system-red)",
  timed_out: "var(--system-orange)",
  abandoned: "var(--text-quaternary)",
  rate_limited: "var(--system-yellow)",
}

const NOTE_FIELDS: Array<{ key: "verification" | "retryNotes" | "residualRisk"; label: string }> = [
  { key: "verification", label: "Verified" },
  { key: "retryNotes", label: "Retry notes" },
  { key: "residualRisk", label: "Residual risk" },
]

export function RunsSection({ runs }: { runs: WorkItemRunWire[] }) {
  return (
    <section data-testid="task-runs">
      <div
        className="mb-3 mt-8 text-[11px] font-semibold uppercase tracking-[.15em] text-[var(--text-secondary)]"
        style={{ fontFamily: "var(--font-code)" }}
      >
        Runs
      </div>
      {runs.length === 0 ? (
        <p data-testid="runs-empty" className="flex min-h-9 items-center text-[13.5px] text-[var(--text-quaternary)]">
          No attempts yet.
        </p>
      ) : (
        runs.map((run) => <RunRow key={run.id} run={run} />)
      )}
    </section>
  )
}

function RunRow({ run }: { run: WorkItemRunWire }) {
  const outcome = run.outcome
  // No hover fill: a run is a record, not a control, and lighting the row up
  // would promise an action that isn't there.
  return (
    <div data-testid={`run-row-${run.id}`} className="py-[7px]">
      <div className="flex min-h-[22px] items-center text-[13.5px]">
        <span className="grid w-4 flex-none place-items-center" aria-hidden>
          {outcome === null ? (
            <span className="size-1.5 rounded-full bg-[var(--system-blue)] animate-[jinn-pulse_1.4s_infinite] motion-reduce:animate-none" />
          ) : (
            <span className="size-1.5 rounded-full" style={{ background: OUTCOME_TINT[outcome] }} />
          )}
        </span>
        <span
          className={`flex-none pl-[14px] font-medium ${
            outcome === null ? "text-[var(--system-blue)]" : "text-[var(--text-primary)]"
          }`}
        >
          {outcome === null ? "Running" : OUTCOME_LABEL[outcome]}
        </span>
        {run.summary && (
          <span className="min-w-0 truncate pl-2.5 text-[var(--text-secondary)]">{run.summary}</span>
        )}
        <span className="ml-auto flex-none pl-2.5 text-[12px] text-[var(--text-quaternary)]">
          {formatRelativeTime(run.startedAt)}
        </span>
      </div>
      <RunHandoff id={run.id} handoff={run.handoff} error={run.error} />
    </div>
  )
}

function RunHandoff({
  id,
  handoff,
  error,
}: {
  id: string
  handoff: WorkItemRunHandoffWire
  error: string | null
}) {
  const files = handoff.changedFiles ?? []
  const notes = NOTE_FIELDS.filter((field) => handoff[field.key])
  if (!error && files.length === 0 && notes.length === 0) return null
  return (
    <dl data-testid={`run-handoff-${id}`} className="mt-1 pl-[30px] text-[12.5px] leading-[1.45]">
      {error && (
        <HandoffField label="Error">
          <span className="text-[var(--system-red)]">{error}</span>
        </HandoffField>
      )}
      {files.length > 0 && (
        <HandoffField label="Changed">
          <span className="flex min-w-0 flex-col">
            {files.map((file) => (
              <span
                key={file}
                title={file}
                className="truncate text-[11.5px] text-[var(--text-tertiary)]"
                style={{ fontFamily: "var(--font-code)" }}
              >
                {file}
              </span>
            ))}
          </span>
        </HandoffField>
      )}
      {notes.map((field) => (
        <HandoffField key={field.key} label={field.label}>
          {handoff[field.key]}
        </HandoffField>
      ))}
    </dl>
  )
}

function HandoffField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2.5 py-[1px]">
      <dt className="w-[76px] flex-none text-[var(--text-quaternary)]">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-[var(--text-secondary)]">{children}</dd>
    </div>
  )
}
