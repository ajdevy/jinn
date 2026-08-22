import { useCallback, useMemo } from 'react'
import type { PaneSessionActions } from '@/components/chat/pane-session-actions'
import { usePins, useTogglePin } from '@/hooks/use-pins'
import { useStopSession, useUpdateSession } from '@/hooks/use-sessions'
import type { ViewMode } from '@/lib/view-mode'

const EMPTY_PINNED_IDS = new Set<string>()

export function usePaneSessionActions({ archive: archiveSession, unarchive, delete: deleteSession, copyId, duplicate, openBeside, setViewMode, copyCliResume, shareDebugLog, clearDebugLog }: {
  archive: (sessionId: string) => void
  unarchive: (sessionId: string) => void
  delete: (sessionId: string) => void
  copyId: (sessionId: string) => void
  duplicate: (sessionId: string) => void
  openBeside: () => void
  setViewMode: (sessionId: string, mode: ViewMode) => void
  copyCliResume: (sessionId: string, command: string) => void
  shareDebugLog: () => void
  clearDebugLog: () => void
}): PaneSessionActions {
  const { data: pinnedIds = EMPTY_PINNED_IDS } = usePins()
  const { mutate: togglePinMutation } = useTogglePin()
  const { mutateAsync: renameMutation } = useUpdateSession()
  const { mutate: stopMutation } = useStopSession()
  const rename = useCallback(async (sessionId: string, title: string) => {
    await renameMutation({ id: sessionId, data: { title } })
  }, [renameMutation])
  const togglePin = useCallback((sessionId: string) => {
    togglePinMutation({ key: sessionId, pinned: !pinnedIds.has(sessionId) })
  }, [pinnedIds, togglePinMutation])
  const archive = useCallback((sessionId: string, archived: boolean) => {
    if (archived) unarchive(sessionId)
    else archiveSession(sessionId)
  }, [archiveSession, unarchive])
  return useMemo(() => ({
    pinnedIds,
    rename,
    togglePin,
    duplicate,
    archive,
    stop: stopMutation,
    copyId,
    delete: deleteSession,
    openBeside,
    setViewMode,
    copyCliResume,
    shareDebugLog,
    clearDebugLog,
  }), [archive, clearDebugLog, copyCliResume, copyId, deleteSession, duplicate, openBeside, pinnedIds, rename, setViewMode, shareDebugLog, stopMutation, togglePin])
}
