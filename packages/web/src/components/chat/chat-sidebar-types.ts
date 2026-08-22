import type { Session } from '@/components/chat/session-signals'

export interface SidebarOrder {
  sessionIds: string[]
  employeeNames: string[]
  employeeSessionMap: Record<string, string[]>
}

export interface ChatSidebarProps {
  selectedId: string | null
  onSelect: (id: string, opts?: { replace?: boolean; navigateMobile?: boolean }) => void
  onNewChat: () => void
  onDelete?: (id: string) => void
  onArchive?: (id: string) => void
  onUnarchive?: (id: string) => void
  onDuplicate?: (newSessionId: string) => void
  onSessionsLoaded?: (sessions: Session[]) => void
  onEmployeeSessionsAvailable?: (sessions: Session[]) => void
  onOrderComputed?: (order: SidebarOrder) => void
  onContactEmployee?: (name: string) => void
  /** Mobile owns swipe gestures; only desktop session rows are draggable. */
  variant?: 'desktop' | 'mobile'
}
