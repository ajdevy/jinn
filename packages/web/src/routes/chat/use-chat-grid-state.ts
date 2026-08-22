import { useEffect, useMemo, useState } from 'react'
import { overflowForViewport } from './grid-layout'
import { mobileWorkingSetIds } from './mobile-working-set-activity'
import { useChatTouchOrder, type ChatTouchOrder } from './use-chat-touch-order'
import { useChatViewport } from './use-chat-viewport'
import type { ChatWorkingSet } from './working-set'

/**
 * The four fixed mobile slots.
 *
 * Nothing is seated until the touch log is in: slots retained from a
 * gateway-activity first pass cannot be displaced by the touched set that
 * arrives a render later, and the same four chips then fail to survive reload.
 */
function useMobileSlots(
  memberIds: readonly string[],
  sessions: ReadonlyArray<{ id?: unknown }> | undefined,
  focusedSessionId: string | null,
  touchOrder: ChatTouchOrder,
): string[] {
  const [slots, setSlots] = useState<string[]>([])
  useEffect(() => {
    if (!touchOrder.hydrated) return
    setSlots((current) => {
      const next = mobileWorkingSetIds(memberIds, sessions ?? [], current, focusedSessionId, touchOrder.ids)
      return next.length === current.length && next.every((id, index) => id === current[index])
        ? current
        : next
    })
  }, [focusedSessionId, memberIds, sessions, touchOrder])
  return slots
}

export function useChatGridState({
  committedId,
  workingSet,
  sessions,
  systemPrimedId,
}: {
  committedId: string | null
  workingSet: ChatWorkingSet
  /** `undefined` until the sessions query resolves, which is distinct from a
   *  gateway that genuinely has no sessions — the touch order must not prune
   *  itself against a list that has not arrived. */
  sessions: ReadonlyArray<{ id?: unknown }> | undefined
  /** The chat the route selected for itself at load rather than the operator
   *  opening it, so it is not a touch. */
  systemPrimedId: string | null
}) {
  const viewport = useChatViewport()
  const touchOrder = useChatTouchOrder(committedId, sessions, systemPrimedId)
  // A URL selection can commit one render before working-set reconciliation.
  // Replace the primary member synchronously so both identities never mount.
  const gridSessionIds = useMemo(() => {
    if (!committedId || workingSet.sessionIds.includes(committedId)) return workingSet.sessionIds
    if (workingSet.focusedId && workingSet.sessionIds.includes(workingSet.focusedId)) {
      return workingSet.sessionIds.map((id) => id === workingSet.focusedId ? committedId : id)
    }
    return [...workingSet.sessionIds, committedId]
  }, [committedId, workingSet.focusedId, workingSet.sessionIds])
  const focusedSessionId = committedId
    ? (!workingSet.sessionIds.includes(committedId) ? committedId : workingSet.focusedId ?? committedId)
    : null
  const reservedComposerSlots = !viewport.mobile && !committedId && workingSet.sessionIds.length > 0 ? 1 : 0
  const visibleWorkingSet = useMemo(() => overflowForViewport({
    ...workingSet,
    sessionIds: gridSessionIds,
    focusedId: focusedSessionId,
  }, viewport.width, viewport.height, reservedComposerSlots).visible, [focusedSessionId, gridSessionIds, reservedComposerSlots, viewport.height, viewport.width, workingSet])
  const mountedSessionIds = viewport.mobile
    ? (focusedSessionId ? [focusedSessionId] : [])
    : visibleWorkingSet.sessionIds
  const mobileSessionIds = useMobileSlots(visibleWorkingSet.sessionIds, sessions, focusedSessionId, touchOrder)
  return { viewport, gridSessionIds, focusedSessionId, mountedSessionIds, mobileSessionIds }
}
