import type { WorkflowAttemptWire } from "@/lib/api"
import { StatusLine, formatDuration, formatStarted } from "./run-support"

function ladderSummary(attempt: WorkflowAttemptWire): string | null {
  const parts: string[] = []
  const reminders = attempt.remindersSent ?? 0
  if (reminders > 0) parts.push(reminders === 1 ? "1 reminder sent" : `${reminders} reminders sent`)
  if (attempt.nextReminderAt) parts.push(`next reminder ${formatStarted(attempt.nextReminderAt)}`)
  const extensions = attempt.extensions ?? 0
  if (extensions > 0) parts.push(extensions === 1 ? "1 extension" : `${extensions} extensions`)
  return parts.length > 0 ? parts.join(" · ") : null
}

export function AttemptCard({ attempt }: { attempt: WorkflowAttemptWire }) {
  const ladder = ladderSummary(attempt)
  return (
    <div className="rounded-[10px] bg-[var(--fill-quaternary)] px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)]">
          Attempt {attempt.attempt}
        </span>
        <StatusLine status={attempt.status} />
        <span
          className="ml-auto text-[length:var(--text-caption1)] text-[var(--text-quaternary)] [font-variant-numeric:tabular-nums]"
          style={{ fontFamily: "var(--font-code)" }}
        >
          {formatDuration(attempt.startedAt, attempt.endedAt)}
        </span>
      </div>
      {attempt.error && (
        <p className="mt-1.5 text-[length:var(--text-caption1)] text-[var(--system-red)]">{attempt.error.message}</p>
      )}
      {ladder && <p className="mt-1.5 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{ladder}</p>}
      {attempt.lastExtensionReason && (
        <p className="mt-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          “{attempt.lastExtensionReason}”
        </p>
      )}
      {attempt.resolvedConfig?.substitutedFrom && (
        <p className="mt-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          Ran on {attempt.resolvedConfig.engine} — {attempt.resolvedConfig.substitutedFrom.engine} was{" "}
          {attempt.resolvedConfig.substitutedFrom.reason}
        </p>
      )}
      {attempt.pendingOutputError && (
        <p className="mt-1.5 text-[length:var(--text-caption1)] text-[var(--system-orange)]">
          Invalid output: {attempt.pendingOutputError}
        </p>
      )}
    </div>
  )
}
