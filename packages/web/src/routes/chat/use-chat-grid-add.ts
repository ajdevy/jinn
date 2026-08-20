import { useCallback } from 'react'
import { useChatSessionDrop } from './chat-grid-drop'

type SelectSession = (
  id: string,
  options?: { navigateMobile?: boolean; replace?: boolean },
) => void

export function useChatGridAdd(
  addSession: (sessionId: string) => void,
  selectedId: string | null,
  selectSession: SelectSession,
) {
  const addPane = useCallback((sessionId: string) => {
    addSession(sessionId)
    if (sessionId !== selectedId) selectSession(sessionId, { navigateMobile: false })
  }, [addSession, selectSession, selectedId])
  const drop = useChatSessionDrop(addPane)
  return { addPane, drop }
}
