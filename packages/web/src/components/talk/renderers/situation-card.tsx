import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

interface SituationCardProps {
  /** Answered with this id — a native button, so Enter and Space come free. */
  choiceId: string
  onAnswer: (choiceId: string) => void
  /** Anything the card cannot stand behind yet, such as an embed that failed. */
  disabled?: boolean
  busy?: boolean
  className?: string
  children: ReactNode
}

/**
 * The one answering control. Every payload renderer builds its cards from this,
 * so answering is a single tap or keypress everywhere and no kind grows its own
 * confirm step. No border at rest: the fill and the hover carry the affordance.
 */
export function SituationCard({
  choiceId,
  onAnswer,
  disabled,
  busy,
  className,
  children,
}: SituationCardProps) {
  return (
    <button
      type="button"
      data-situation-card={choiceId}
      disabled={disabled}
      aria-busy={busy || undefined}
      onClick={() => onAnswer(choiceId)}
      className={cn(
        "w-full cursor-pointer rounded-[var(--radius-lg)] border-none bg-[var(--fill-tertiary)]",
        "p-[var(--space-3)] text-left text-[length:var(--text-subheadline)] text-[var(--text-primary)]",
        "transition-[background-color,scale] duration-150 ease-[var(--ease-smooth)]",
        "hover:bg-[var(--fill-secondary)] active:scale-[0.98]",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
        "disabled:cursor-default disabled:opacity-60 disabled:active:scale-100",
        className,
      )}
    >
      {children}
    </button>
  )
}
