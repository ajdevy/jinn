import { useEffect, useRef, useState } from 'react'
import { loadPersistedTouchOrder, persistTouchOrder, recordTouchedSession } from './touch-order'

/**
 * The chats the operator has opened, most recent first.
 *
 * Records on the COMMITTED selection rather than the URL's, so the log follows
 * the chat that actually reached the screen: `selection-commit.ts` holds a
 * switch until the destination can paint, and a navigation superseded during
 * that hold never becomes a touch. Every way in — a strip chip, a list row, a
 * deep link, back and forward — arrives here as a committed id.
 */
export function useChatTouchOrder(
  committedId: string | null,
  sessions: ReadonlyArray<{ id?: unknown }> | undefined,
): string[] {
  const [order, setOrder] = useState<string[]>(() => (committedId ? [committedId] : []))
  const hydratedRef = useRef(false)

  useEffect(() => {
    if (!sessions || hydratedRef.current || typeof window === 'undefined') return
    const liveIds = new Set(sessions.map((session) => String(session.id ?? '')).filter(Boolean))
    let restored = loadPersistedTouchOrder(window.localStorage, liveIds)
    if (committedId) restored = recordTouchedSession(restored, committedId)
    hydratedRef.current = true
    setOrder(restored)
  }, [committedId, sessions])

  useEffect(() => {
    if (!hydratedRef.current || !committedId) return
    setOrder((current) => recordTouchedSession(current, committedId))
  }, [committedId])

  useEffect(() => {
    if (!hydratedRef.current || typeof window === 'undefined') return
    persistTouchOrder(window.localStorage, order)
  }, [order])

  return order
}
