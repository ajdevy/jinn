import { Plus, Zap } from "lucide-react"

/**
 * The two ways to put work on the board, side by side.
 *
 * They are deliberately not the same weight. `New Todo` opens the full form and
 * keeps the accent fill, because it is the deliberate act. Quick capture is the
 * cheap one — a rough sentence thrown at the system — so it reads as a quiet
 * secondary control rather than competing with it.
 */

export function BoardHeaderActions({
  onQuickCapture,
  onNewTodo,
}: {
  onQuickCapture: () => void
  onNewTodo: () => void
}) {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-2">
      <button
        type="button"
        data-testid="todo-quick-capture"
        onClick={onQuickCapture}
        aria-label="Quick capture"
        title="Quick capture — type or dictate a rough idea"
        className="focus-ring inline-flex size-10 items-center justify-center rounded-full bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-[var(--shadow-ambient),var(--shadow-subtle),var(--inset-shine)] outline-none transition-transform hover:scale-[0.96] motion-reduce:transition-none"
      >
        <Zap className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        data-testid="todo-new"
        onClick={onNewTodo}
        aria-label="New todo"
        className="inline-flex min-h-10 min-w-10 items-center justify-center gap-1.5 rounded-full text-[length:var(--text-subheadline)] font-semibold transition-transform hover:scale-[0.98] md:px-[18px]"
        style={{ background: "var(--accent-fill)", color: "var(--accent)", boxShadow: "var(--inset-shine)" }}
      >
        <Plus className="size-4" aria-hidden />
        <span className="max-md:hidden">New Todo</span>
      </button>
    </div>
  )
}
