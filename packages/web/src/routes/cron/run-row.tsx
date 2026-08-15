import { Link } from "react-router-dom"
import { formatDuration, formatRunTime } from "@/lib/cron-utils"
import { sessionPath } from "@/components/chat/chat-route-helpers"
import { RunGlyph, runDurationMs, runOutcome, runTimestamp, type CronRunWire } from "./shared"

/* design-cron §2.4 — one fire of a job in the run history: the outcome glyph,
 * when it ran, the word for anything other than a plain success, and how long
 * it took. */

const RUN_STATUS_WORD: Record<string, string> = { error: "error" }

const RUN_ROW_CLASS = "flex min-h-[44px] items-center gap-2.5 rounded-[13px] py-1.5 pl-2.5 pr-3.5"
const RUN_ROW_LINK_CLASS = `${RUN_ROW_CLASS} transition-colors duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-quaternary)] focus-visible:bg-[var(--fill-quaternary)] focus-visible:outline-none`

export function RunRow({ run, now }: { run: CronRunWire; now: Date }) {
  const outcome = runOutcome(run)
  const ts = runTimestamp(run)
  const dur = runDurationMs(run)
  const word = run.status ? RUN_STATUS_WORD[run.status] : undefined
  const columns = (
    <>
      <RunGlyph outcome={outcome} size={22} />
      <span className="min-w-0 flex-1 truncate text-[length:var(--text-footnote)] text-[var(--text-primary)]">
        {ts != null ? formatRunTime(ts, now) : "—"}
      </span>
      {word && <span className="flex-none text-[length:var(--text-caption1)]" style={{ color: outcome === "error" ? "var(--system-red)" : "var(--text-tertiary)" }}>{word}</span>}
      <span className="min-w-[52px] flex-none text-right text-[length:var(--text-caption1)] tabular-nums text-[var(--text-tertiary)]" style={{ fontFamily: "var(--font-code)" }}>
        {dur != null ? formatDuration(dur) : "—"}
      </span>
    </>
  )
  // An errored fire that never spawned a session, or history written before the
  // field existed, stays inert: a hover fill on a row that goes nowhere is a
  // false affordance.
  if (!run.sessionId) return <div className={RUN_ROW_CLASS}>{columns}</div>
  return <Link to={sessionPath(run.sessionId)} className={RUN_ROW_LINK_CLASS}>{columns}</Link>
}
