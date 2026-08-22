import { Ellipsis } from 'lucide-react'
import { SessionRowMenu, SESSION_MENU_CONTENT_CLASS } from '@/components/chat/session-row-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { Session } from '@/components/chat/session-signals'
import type { PaneSessionActions } from '@/components/chat/pane-session-actions'

async function renamePane(title: string, sessionId: string, actions: PaneSessionActions, onRenamed: (title: string) => void): Promise<void> {
  const next = window.prompt('Rename chat', title)?.trim()
  if (!next || next === title) return
  onRenamed(next)
  try { await actions.rename(sessionId, next) } catch { onRenamed(title) }
}

export function ChatPaneSessionMenu({
  title,
  session,
  actions,
  onRenamed,
}: {
  title: string
  session: Session
  actions: PaneSessionActions
  onRenamed: (title: string) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-pane-focus-preserving
          data-chat-pane-menu-trigger
          aria-label={`Actions for ${title}`}
          onClick={(event) => event.stopPropagation()}
          className="absolute left-0 grid size-[26px] place-items-center rounded-[var(--radius-sm)] border-0 bg-transparent text-[var(--text-secondary)] opacity-0 transition-[color,opacity] duration-[var(--duration-fast)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] focus-visible:opacity-100 data-[state=open]:opacity-100 group-hover/chat-pane:opacity-100"
        >
          <Ellipsis size={14} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        data-pane-focus-preserving
        onClick={(event) => event.stopPropagation()}
        className={SESSION_MENU_CONTENT_CLASS}
      >
        <SessionRowMenu
          variant="dropdown"
          session={session}
          isPinned={actions.pinnedIds.has(session.id)}
          isArchived={Boolean(session.archivedAt)}
          onRename={() => { void renamePane(title, session.id, actions, onRenamed) }}
          onTogglePin={() => actions.togglePin(session.id)}
          onDuplicate={() => actions.duplicate(session.id)}
          onArchive={() => actions.archive(session.id, Boolean(session.archivedAt))}
          onStop={() => actions.stop(session.id)}
          onCopyId={() => actions.copyId(session.id)}
          onDelete={() => { if (window.confirm('Delete this session?')) actions.delete(session.id) }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
