import { useCallback, useEffect, useRef, useState } from 'react'
import {
  addWorkingSetSession,
  createWorkingSet,
  focusWorkingSetSession,
  insertWorkingSetSession,
  loadPersistedWorkingSet,
  persistWorkingSet,
  removeWorkingSetSession,
  replaceFocusedWorkingSetSession,
  type ChatWorkingSet,
} from './working-set'
import { capForViewport } from './grid-layout'

function viewportCap(): number {
  if (typeof window === 'undefined') return 4
  return capForViewport(window.innerWidth, window.innerHeight)
}

export function useChatWorkingSet(
  committedId: string | null,
  sessions: Array<{ id?: unknown }> | undefined,
) {
  const [state, setState] = useState<ChatWorkingSet>(() => (
    committedId ? createWorkingSet([committedId], committedId) : createWorkingSet()
  ))
  const hydratedRef = useRef(false)

  useEffect(() => {
    if (!sessions || hydratedRef.current || typeof window === 'undefined') return
    const liveIds = new Set(sessions.map((session) => String(session.id ?? '')).filter(Boolean))
    let restored = loadPersistedWorkingSet(window.localStorage, liveIds, viewportCap())
    if (committedId) {
      restored = restored.sessionIds.length === 0
        ? createWorkingSet([committedId], committedId)
        : replaceFocusedWorkingSetSession(restored, committedId)
    }
    hydratedRef.current = true
    setState(restored)
  }, [committedId, sessions])

  useEffect(() => {
    if (!hydratedRef.current || !committedId) return
    setState((current) => replaceFocusedWorkingSetSession(current, committedId))
  }, [committedId])

  useEffect(() => {
    if (!hydratedRef.current || typeof window === 'undefined') return
    persistWorkingSet(window.localStorage, state)
  }, [state])

  const add = useCallback((sessionId: string) => {
    setState((current) => addWorkingSetSession(current, sessionId, viewportCap()))
  }, [])
  const focus = useCallback((sessionId: string) => {
    setState((current) => focusWorkingSetSession(current, sessionId))
  }, [])
  const insert = useCallback((sessionId: string, index: number) => {
    setState((current) => insertWorkingSetSession(current, sessionId, index, viewportCap()))
  }, [])
  const remove = useCallback((sessionId: string) => {
    setState((current) => removeWorkingSetSession(current, sessionId))
  }, [])

  return { state, add, insert, focus, remove }
}
