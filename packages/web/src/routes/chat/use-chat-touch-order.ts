import { useEffect, useState } from 'react'
import { loadPersistedTouchOrder, persistTouchOrder, recordTouchedSession } from './touch-order'

export interface ChatTouchOrder {
  /** The chats the operator has opened, most recent first. */
  ids: string[]
  /**
   * The persisted log has been read. Until it has, the mobile slots must stay
   * empty: seating them from gateway activity first lets slot retention hold
   * those ids against the touched set that arrives a render later, and the same
   * four chips then fail to survive a reload.
   */
  hydrated: boolean
}

/**
 * The chats the operator has opened, most recent first.
 *
 * Records on the COMMITTED selection rather than the URL's, so the log follows
 * the chat that actually reached the screen: `selection-commit.ts` holds a
 * switch until the destination can paint, and a navigation superseded during
 * that hold never becomes a touch. Every way in — a strip chip, a list row, a
 * deep link, back and forward — arrives here as a committed id.
 *
 * `systemPrimedId` is the other half of that: the route also commits a session
 * nobody asked for — `handleSessionsLoaded` primes the newest chat so the
 * thread has something to show, and the delete, archive and tab-restore
 * fallbacks pick a neighbour. The route names that chat here, and it stays out
 * of the log until the operator selects it themselves. Whether the thread is on
 * screen cannot stand in for that: showing it is what New chat does on a phone
 * one render before the navigation clears the primed selection.
 */
export function useChatTouchOrder(
  committedId: string | null,
  sessions: ReadonlyArray<{ id?: unknown }> | undefined,
  systemPrimedId: string | null,
): ChatTouchOrder {
  const openedId = committedId && committedId !== systemPrimedId ? committedId : null
  const [state, setState] = useState<ChatTouchOrder>({ ids: [], hydrated: false })

  useEffect(() => {
    if (!sessions || state.hydrated) return
    if (typeof window === 'undefined') {
      setState({ ids: [], hydrated: true })
      return
    }
    const liveIds = new Set(sessions.map((session) => String(session.id ?? '')).filter(Boolean))
    const restored = loadPersistedTouchOrder(window.localStorage, liveIds)
    setState({
      ids: openedId ? recordTouchedSession(restored, openedId) : restored,
      hydrated: true,
    })
  }, [openedId, sessions, state.hydrated])

  useEffect(() => {
    if (!state.hydrated || !openedId) return
    setState((current) => {
      const ids = recordTouchedSession(current.ids, openedId)
      return ids === current.ids ? current : { ...current, ids }
    })
  }, [openedId, state.hydrated])

  useEffect(() => {
    if (!state.hydrated || typeof window === 'undefined') return
    persistTouchOrder(window.localStorage, state.ids)
  }, [state.hydrated, state.ids])

  return state
}
