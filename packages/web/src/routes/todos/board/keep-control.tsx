import { Pin } from "lucide-react"
import type { WorkItemCompactWire } from "@/lib/api"
import { departmentTitle } from "./board-switcher"

/* ICI-1357 — keeping a Todo on Home, and saying whose work a kept Todo is.
 *
 * Home mixes what the operator asked for with what they pulled onto it, so the
 * caption is load-bearing rather than decoration: without it a board holding
 * both reads as one undifferentiated pile.
 *
 * Both parts are presentational — the mutation lives in use-board.ts with the
 * board's others, and reaches the card as a callback like every other action. */

/**
 * The toggle. `revealOnHover` is the board card's rule: an unkept card shows
 * its pin only on hover of the surrounding `group` or on keyboard focus, and
 * the button still occupies its box either way — opacity, never mounting, is
 * what hides it, so a card cannot resize as the pointer crosses it. A kept
 * Todo always shows its pin. Anywhere without a hover group to belong to (the
 * task page's toolbar) leaves the flag off and the control simply shows.
 */
export function KeepToggle(
  { id, kept = false, onToggle, revealOnHover = false, className = "" }:
  { id: string; kept?: boolean; onToggle: (vars: { id: string; kept: boolean }) => void; revealOnHover?: boolean; className?: string },
) {
  return (
    <button
      type="button"
      data-testid={`keep-toggle-${id}`}
      aria-pressed={kept}
      aria-label={kept ? `Kept on Home — remove ${id} from Home` : `Keep ${id} on Home`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onToggle({ id, kept: !kept })
      }}
      className={[
        "focus-ring grid size-[22px] flex-none place-items-center rounded-md outline-none transition-opacity duration-150",
        "hover:bg-[var(--fill-quaternary)]",
        kept ? "text-[var(--accent)]" : "text-[var(--text-quaternary)]",
        revealOnHover && !kept ? "opacity-0 focus-visible:opacity-100 group-hover:opacity-100" : "",
        className,
      ].join(" ")}
    >
      <Pin size={13} strokeWidth={2} aria-hidden className={kept ? "fill-current" : ""} />
    </button>
  )
}

/** Whose work a kept Todo is. Only for a Todo the operator did not raise — on
 *  their own, "Kept" says nothing they do not already know — and only when
 *  there is a department to name, so the line never reads `Kept · undefined`. */
export function keptCaptionOf(item: WorkItemCompactWire): string | null {
  if (item.kept !== true || item.createdBy === "operator" || !item.department) return null
  return `Kept · ${departmentTitle(item.department)}`
}

export function KeptCaption({ item, className = "" }: { item: WorkItemCompactWire; className?: string }) {
  const caption = keptCaptionOf(item)
  if (!caption) return null
  return (
    <div
      data-testid={`kept-caption-${item.id}`}
      className={`flex items-center gap-1.5 text-[12px] text-[var(--text-quaternary)] ${className}`}
    >
      <Pin size={10} strokeWidth={2} aria-hidden className="flex-none" />
      {caption}
    </div>
  )
}
