export interface PaneSessionActions {
  pinnedIds: ReadonlySet<string>
  rename: (sessionId: string, title: string) => Promise<void>
  togglePin: (sessionId: string) => void
  duplicate: (sessionId: string) => void
  archive: (sessionId: string, archived: boolean) => void
  stop: (sessionId: string) => void
  delete: (sessionId: string) => void
}
