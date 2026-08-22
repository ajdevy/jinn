import type { ViewMode } from '@/lib/view-mode'

export interface PaneSessionActions {
  pinnedIds: ReadonlySet<string>
  rename: (sessionId: string, title: string) => Promise<void>
  togglePin: (sessionId: string) => void
  duplicate: (sessionId: string) => void
  archive: (sessionId: string, archived: boolean) => void
  stop: (sessionId: string) => void
  copyId: (sessionId: string) => void
  delete: (sessionId: string) => void
  openBeside?: () => void
  setViewMode?: (sessionId: string, mode: ViewMode) => void
  copyCliResume?: (sessionId: string, command: string) => void
  shareDebugLog?: () => void
  clearDebugLog?: () => void
}
