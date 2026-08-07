export function OverduePill({ id }: { id: string }) {
  return (
    <span
      className="shrink-0 rounded-full px-1.5 py-0.5 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[0.08em] text-[var(--system-orange)]"
      style={{ background: "color-mix(in srgb, var(--system-orange) 12%, transparent)" }}
      data-testid={`experiment-overdue-${id}`}
    >
      Overdue
    </span>
  )
}
