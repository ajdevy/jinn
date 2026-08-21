import { Plus } from 'lucide-react'

export function ChatGridAddMenu({ onAdd }: { onAdd: () => void }) {
  return (
    <button
      type="button"
      aria-label="Add chat to grid"
      title="Add chat to grid"
      onClick={onAdd}
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] lg:size-8"
    >
      <Plus size={18} aria-hidden />
    </button>
  )
}
