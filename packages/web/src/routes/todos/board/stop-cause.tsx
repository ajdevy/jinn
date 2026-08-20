import { useEffect, useState } from "react"
import { Pause, TriangleAlert } from "lucide-react"
import type { WorkItemCompactWire, WorkItemStatusWire } from "@/lib/api"
import { isParked } from "@/lib/parked"
import { formatCountdown } from "../util"

/* PLA-157 — how a stopped card says why it stopped.
 *
 * Two different waits used to render identically: a Todo held by a quota window
 * and a Todo held by a person both became one tinted line under the title, and
 * that line was hidden below 700px. So the board's "N waiting" counted clocks as
 * people, and the phone showed neither.
 *
 * The countdown chip and the unblock hint separate them, and both LEAD the card
 * at every width: on a card that has stopped, the wait is the headline and the
 * title is the detail. The plain why-line stays for the ordinary case — a block
 * whose only explanation is its transition note. */

/** Whether the card carries a lead at all, from the fields alone and never from
 *  the clock: `cardLayoutKey` feeds the column's FLIP, and a key that changed on
 *  every tick would make the column re-measure once a minute forever. */
export function hasStopLead(item: WorkItemCompactWire): boolean {
  return !!item.parkedUntil || !!item.unblockHint
}

/** The park's remaining time, re-read on a timer so the chip goes away the moment
 *  it runs out rather than at the next refetch. Nothing parked installs no timer,
 *  so a board of ordinary cards costs none. */
function useCountdown(parkedUntil: string | undefined): string {
  const [now, setNow] = useState(() => Date.now())
  const ticking = isParked(parkedUntil, now)
  useEffect(() => {
    if (!ticking) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [ticking])
  return ticking && parkedUntil ? formatCountdown(parkedUntil, now) : ""
}

/** Above the title, on desktop and on the phone: what this card is waiting for. */
export function StopCauseLead({ item }: { item: WorkItemCompactWire }) {
  const left = useCountdown(item.parkedUntil)
  const hint = item.unblockHint
  if (!left && !hint) return null
  return (
    // Stacked, not side by side: the board's columns are ~200px, and a card
    // carrying both a chip and a hint had the hint's `who` clipped off its edge.
    <div
      data-testid={`stop-lead-${item.id}`}
      className="mt-1.5 flex min-w-0 flex-col items-start gap-1 max-[700px]:order-first max-[700px]:mt-0 max-[700px]:basis-full"
    >
      {left && (
        <span
          data-testid={`park-chip-${item.id}`}
          className="inline-flex h-5 max-w-full flex-none items-center gap-1 whitespace-nowrap rounded-[10px] px-2 text-[11px] font-medium [font-variant-numeric:tabular-nums]"
          style={{ background: "color-mix(in srgb, var(--system-orange) 18%, transparent)", color: "var(--system-orange)" }}
        >
          <Pause size={10} aria-hidden />
          Parked · {left}
        </span>
      )}
      {hint && (
        <span
          className="max-w-full truncate text-[12px] font-medium leading-[1.35]"
          style={{ color: item.status === "escalated" ? "var(--system-red)" : "var(--system-orange)" }}
        >
          {hint.what}
          <span className="font-normal text-[var(--text-tertiary)]"> · {hint.who}</span>
        </span>
      )}
    </div>
  )
}

/** The one-line why on blocked/escalated cards: the latest transition note. The
 *  mock leads the line with a small bare status glyph (F4). */
export function CauseLine({ status, reason }: { status: WorkItemStatusWire; reason: string }) {
  return (
    <div
      className={`mt-2 flex items-center gap-1.5 text-[12px] max-[700px]:hidden ${
        status === "escalated" ? "text-[var(--system-red)]" : "text-[var(--system-orange)]"
      }`}
    >
      {status === "escalated" ? (
        <TriangleAlert size={11} aria-hidden className="flex-none" />
      ) : (
        <Pause size={11} aria-hidden className="flex-none" />
      )}
      {reason}
    </div>
  )
}
