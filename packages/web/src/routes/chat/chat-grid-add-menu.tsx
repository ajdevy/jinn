import { Plus } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface GridSessionOption {
  id?: unknown
  title?: string
  employee?: string
}

export function ChatGridAddMenu({ sessions, memberIds, onAdd }: {
  sessions: GridSessionOption[]
  memberIds: string[]
  onAdd: (sessionId: string) => void
}) {
  const members = new Set(memberIds)
  const options = sessions
    .filter((session): session is GridSessionOption & { id: string } => typeof session.id === 'string' && !members.has(session.id))

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Add chat to grid"
          title="Add chat to grid"
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] lg:size-8"
        >
          <Plus size={18} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[260px] border-0 bg-[var(--material-thick)] shadow-[var(--shadow-overlay)]">
        <DropdownMenuLabel className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">Open beside</DropdownMenuLabel>
        {options.length === 0 ? (
          <DropdownMenuItem disabled>Every chat is already open</DropdownMenuItem>
        ) : options.map((session) => (
          <DropdownMenuItem key={session.id} onSelect={() => onAdd(session.id)} className="min-w-0">
            <span className="min-w-0 flex-1 truncate">{session.title?.trim() || session.employee || 'Untitled'}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
