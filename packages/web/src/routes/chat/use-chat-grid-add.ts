import { useCallback } from 'react'
import { useChatSessionDrop } from './chat-grid-drop'

type SelectSession = (
  id: string,
  options?: { navigateMobile?: boolean; replace?: boolean },
) => void

export function useChatGridAdd(
  addSession: (sessionId: string) => void,
  insertSession: (sessionId: string, index: number) => void,
  selectedId: string | null,
  selectSession: SelectSession,
) {
  const addPane = useCallback((sessionId: string) => {
    addSession(sessionId)
    if (sessionId !== selectedId) selectSession(sessionId, { navigateMobile: false })
  }, [addSession, selectSession, selectedId])
  const insertPane = useCallback((sessionId: string, index: number) => {
    insertSession(sessionId, index)
    if (sessionId !== selectedId) selectSession(sessionId, { navigateMobile: false })
  }, [insertSession, selectSession, selectedId])
  const drop = useChatSessionDrop(insertPane)
  return { addPane, drop }
}
