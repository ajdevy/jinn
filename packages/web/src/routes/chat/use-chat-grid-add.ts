import { useCallback } from 'react'
import { useChatSessionDrop, type ChatSessionDropContext } from './chat-grid-drop'
import { capForViewport } from './grid-layout'

type SelectSession = (
  id: string,
  options?: { navigateMobile?: boolean; replace?: boolean },
) => void

type ChatGridAddDropContext = Omit<ChatSessionDropContext, 'cap'>

export function useChatGridAdd(
  addSession: (sessionId: string) => void,
  insertSession: (sessionId: string, index: number) => void,
  selectedId: string | null,
  selectSession: SelectSession,
  dropContext: ChatGridAddDropContext,
) {
  const addPane = useCallback((sessionId: string) => {
    addSession(sessionId)
    if (sessionId !== selectedId) selectSession(sessionId, { navigateMobile: false })
  }, [addSession, selectSession, selectedId])
  const insertPane = useCallback((sessionId: string, index: number) => {
    insertSession(sessionId, index)
    if (sessionId !== selectedId) selectSession(sessionId, { navigateMobile: false })
  }, [insertSession, selectSession, selectedId])
  const drop = useChatSessionDrop(insertPane, {
    ...dropContext,
    cap: capForViewport(dropContext.viewport.width, dropContext.viewport.height),
  })
  return { addPane, drop }
}
