import { Search } from "lucide-react"

/** The Todos search box is an entry point to the one global overlay, not a
 *  second search implementation. A button cannot drop the first keystroke the
 *  way an input handing its value onward can, so a printable key opens the
 *  overlay already seeded with that character. */
export function SearchLauncher({
  className,
  iconSize,
  labelClassName,
  onOpen,
}: {
  className: string
  iconSize: number
  labelClassName: string
  onOpen: (seed?: string) => void
}) {
  return (
    <button
      type="button"
      aria-label="Search todos"
      data-testid="filter-search"
      onClick={() => onOpen()}
      onKeyDown={(e) => {
        // Enter and Space stay the button's own activation keys.
        if (e.key.length !== 1 || e.key === " " || e.metaKey || e.ctrlKey || e.altKey) return
        e.preventDefault()
        onOpen(e.key)
      }}
      className={`focus-ring outline-none transition-colors hover:bg-[var(--fill-secondary)] ${className}`}
    >
      <Search size={iconSize} strokeWidth={2} className="flex-none text-[var(--text-quaternary)]" aria-hidden />
      <span className={labelClassName}>Search todos</span>
    </button>
  )
}
